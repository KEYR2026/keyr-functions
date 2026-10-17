const { AGENT_IDENTITY_RESPONSE, AGENT_CAPABILITIES_RESPONSE, FINANCIAL_COACH_DIFFERENTIATION, DEFAULT_SUGGESTED_QUESTIONS, PRIVACY_NOTICE, SENSITIVE_DATA_WARNING, CONSENT_NOTICE, CONTACT_TOPIC_OPTIONS, CONTACT_TOPIC_MAP } = require('./keyrConciergePrompts');
const { getPublicKnowledge, findKnowledgeById, getApprovedProductOverview } = require('./keyrPublicKnowledge');
const { NAVIGATION_ALLOWLIST, resolveRoute, isAllowedRoute } = require('./keyrNavigationMap');
const { getCompetitorProfile, isCompetitorFresh } = require('./keyrCompetitorKnowledge');
const { buildPrivacyMetadata, validateRequestBody, validateModelResponse, sanitizeText, isValidEmail, hasSensitivePattern, sanitizePublicResponseText, hasProhibitedEncodingArtifact } = require('./keyrConciergeValidator');
const { ensureConversationState, resolveConversationState, updateConversationState, generateConversationId, normalizeConversationId, getStateConfig, pruneTurnHistory, checkRateLimit } = require('./keyrConciergeState');

const routerExports = {};
let injectedSubmitContactRequest = null;

function setSubmitContactRequest(submitter) {
  injectedSubmitContactRequest = submitter || null;
}

function getSubmitContactRequest() {
  return injectedSubmitContactRequest || require('../services/keyrContactSubmissionService').submitContactRequest;
}

function buildAction(label, routeId) {
  const route = resolveRoute(routeId);
  if (!route) {
    return null;
  }
  return {
    label,
    routeId,
    url: route.url
  };
}

function buildBaseResponse({ conversationId, intent, message, actions = [], suggestedQuestions = [], notice = 'Public website information only.' }) {
  const safeMessage = sanitizePublicResponseText(message, 'I can help with general information about KEYR, but I do not have sufficiently approved information for that question.');
  return {
    success: true,
    agent: 'KEYR Concierge',
    conversationId,
    intent,
    answerSource: 'deterministic',
    message: safeMessage,
    actions,
    suggestedQuestions: suggestedQuestions.length ? suggestedQuestions : DEFAULT_SUGGESTED_QUESTIONS,
    notice,
    privacy: buildPrivacyMetadata(),
    contactFlow: null
  };
}

function getCurrentDateChicago() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
  return formatter.format(new Date());
}

function normalizeQuestion(question) {
  return String(question || '')
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function getActionListForIntent(intent) {
  const actions = [];
  switch (intent) {
    case 'AGENT_IDENTITY':
      actions.push(buildAction('Explore Products', 'explore'));
      actions.push(buildAction('View Pricing', 'pricing'));
      break;
    case 'AGENT_CAPABILITIES':
      actions.push(buildAction('Explore Products', 'explore'));
      actions.push(buildAction('FAQs', 'faq'));
      break;
    case 'BUY_OR_APPLY':
      actions.push(buildAction('Apply', 'apply'));
      actions.push(buildAction('Pricing', 'pricing'));
      break;
    case 'CONTACT':
      actions.push(buildAction('Contact', 'contact'));
      actions.push(buildAction('FAQs', 'faq'));
      break;
    default:
      actions.push(buildAction('Explore Products', 'explore'));
      actions.push(buildAction('Contact', 'contact'));
      break;
  }
  return actions.filter(Boolean);
}

function classifyIntent(question, state = null) {
  const q = normalizeQuestion(question).toLowerCase();

  if (!q) {
    return 'UNKNOWN';
  }

  const previousIntent = state && state.previousIntent ? String(state.previousIntent).toUpperCase() : null;
  const hasComparisonContext = previousIntent === 'COMPARISON' || previousIntent === 'PRODUCT_OVERVIEW';

  if (q.includes('autopay advantage') || q.includes('autopay')) {
    return 'AUTO_PAY_ADVANTAGE';
  }

  if (q.includes('pricing')) {
    return 'NAVIGATION';
  }

  if (hasComparisonContext && (/what about|how about|which has|which is better|potential unsecured|compare|comparison|different from|vs\b|versus|unsecured path/.test(q))) {
    return 'COMPARISON';
  }

  if (/what about|how about|which has|which is better|compare|comparison|different from|vs\b|versus|unsecured path/.test(q) || (q.includes('discover') || q.includes('chime') || q.includes('capital one') || q.includes('chase') || q.includes('bank of america') || q.includes('american express'))) {
    return 'COMPARISON';
  }

  const primaryEligibilityPatterns = ['will i qualify', 'am i eligible', 'can i get approved', 'do i meet the requirements', 'do i qualify', 'am i approved', 'will i be approved'];
  if (primaryEligibilityPatterns.some((pattern) => q.includes(pattern))) return 'ELIGIBILITY';

  const productGuidancePatterns = [
    'explain',
    'compare',
    'help me understand',
    'how do the products work',
    'how do the products differ',
    'how do the different parts of keyr',
    'what are the differences between',
    'how does keyr help with',
    'how are the keyr products intended to'
  ];
  if (productGuidancePatterns.some((pattern) => q.includes(pattern))) return 'COMPARISON';

  const identityPatterns = ['who are you', 'what are you', 'tell me about yourself', 'what is keyr concierge', 'introduce yourself', 'who am i speaking with'];
  if (identityPatterns.some((pattern) => q.includes(pattern))) return 'AGENT_IDENTITY';

  const capabilityPatterns = ['what can you do', 'how can you help me', 'what questions can i ask', 'what do you help with', 'what are your capabilities'];
  if (capabilityPatterns.some((pattern) => q.includes(pattern))) return 'AGENT_CAPABILITIES';

  const financialCoachPatterns = ['are you the ai financial coach', 'are you the financial coach', 'are you the personal coach', 'what is the financial coach', 'what is the ai coach', 'what is the personal coach', 'does keyr have two ai agents', 'does keyr have more than one ai', 'can you access my account'];
  if (financialCoachPatterns.some((pattern) => q.includes(pattern))) return 'FINANCIAL_COACH_DIFFERENTIATION';

  const todayPatterns = ['what is today\'s date', 'what day is it', 'what is the current date', 'can you tell me today\'s date'];
  if (todayPatterns.some((pattern) => q.includes(pattern))) return 'CURRENT_DATE';

  const founderPatterns = ['who founded keyr', 'who owns keyr', 'who created keyr'];
  if (founderPatterns.some((pattern) => q.includes(pattern))) return 'FOUNDER';

  const locationPatterns = ['where is keyr based', 'where is keyr headquartered', 'is keyr an oklahoma company'];
  if (locationPatterns.some((pattern) => q.includes(pattern))) return 'BUSINESS_LOCATION';

  const keyrOverviewPatterns = ['what is keyr', 'tell me about keyr', 'what is keyr company'];
  if (keyrOverviewPatterns.some((pattern) => q.includes(pattern))) return 'KEYR_OVERVIEW';

  const anchorPatterns = ['what is anchor', 'tell me about anchor', 'anchor overview'];
  if (anchorPatterns.some((pattern) => q.includes(pattern))) return 'PRODUCT_OVERVIEW';

  const ascendPatterns = ['what is ascend', 'tell me about ascend'];
  if (ascendPatterns.some((pattern) => q.includes(pattern))) return 'PRODUCT_OVERVIEW';

  const apexPatterns = ['what is apex', 'tell me about apex'];
  if (apexPatterns.some((pattern) => q.includes(pattern))) return 'PRODUCT_OVERVIEW';

  const safeStartPatterns = ['what is safe start', 'what is safe-start', 'is safe start a card', 'safe start overview'];
  if (safeStartPatterns.some((pattern) => q.includes(pattern))) return 'SAFE_START';

  const applyPatterns = ['how do i apply', 'apply now', 'how can i apply', 'i want to apply'];
  if (applyPatterns.some((pattern) => q.includes(pattern))) return 'APPLY';

  const contactPatterns = ['contact me', 'can someone call me', 'i want to speak with someone', 'i need application help', 'i have a partnership question', 'i have an investment question', 'i have a grant opportunity', 'i have a media request', 'i have a privacy concern', 'i have a security concern', 'i still need help', 'that did not answer my question', 'i want a human'];
  if (contactPatterns.some((pattern) => q.includes(pattern))) return 'CONTACT';

  const privacyPatterns = ['privacy policy', 'terms of use', 'security', 'privacy'];
  if (privacyPatterns.some((pattern) => q.includes(pattern))) return 'PRIVACY';

  const navigationPatterns = ['how do i navigate', 'where do i go', 'show me the pricing page', 'take me to contact', 'what pages are there'];
  if (navigationPatterns.some((pattern) => q.includes(pattern))) return 'NAVIGATION';

  if (q.includes('compare') || q.includes('comparison') || q.includes('different from') || q.includes('vs') || q.includes('versus')) {
    return 'COMPARISON';
  }

  if (q.includes('balance') && (q.includes('my') || q.includes('account'))) return 'ACCOUNT_BOUNDARY';
  if (q.includes('qualify') || q.includes('eligible') || q.includes('approval')) return 'ELIGIBILITY';
  if (q.includes('balance transfer') || q.includes('which balance should i transfer')) return 'PERSONALIZED_PLAN';
  if (q.includes('account number') || q.includes('password') || q.includes('ssn') || q.includes('card number')) return 'SENSITIVE_DATA_WARNING';

  return 'UNCERTAIN';
}

function getProductNameFromQuestion(question, state) {
  const q = normalizeQuestion(question).toLowerCase();
  const matches = ['anchor', 'ascend', 'apex', 'safe start'];
  const hit = matches.find((product) => q.includes(product));
  if (hit) {
    if (hit === 'safe start') return 'Safe Start';
    return hit.charAt(0).toUpperCase() + hit.slice(1);
  }

  if (state && state.currentKeyrProduct) {
    return state.currentKeyrProduct;
  }

  return null;
}

function buildComparisonEntities(question, state) {
  const q = normalizeQuestion(question);
  const entities = [];
  if (state && Array.isArray(state.comparisonEntities)) {
    entities.push(...state.comparisonEntities);
  }
  const names = ['Chime', 'Discover', 'Capital One', 'Chase', 'Bank of America', 'American Express'];
  names.forEach((name) => {
    if (q.toLowerCase().includes(name.toLowerCase()) && !entities.includes(name)) {
      entities.push(name);
    }
  });
  return entities.slice(0, 4);
}

function createApprovedResponse({ conversationId, intent, message, actions, suggestedQuestions = DEFAULT_SUGGESTED_QUESTIONS, notice = 'Public website information only.' }) {
  const cleanMessage = sanitizePublicResponseText(message, 'I can help with general information about KEYR, but I do not have sufficiently approved information for that question.');
  return {
    success: true,
    agent: 'KEYR Concierge',
    conversationId,
    intent,
    answerSource: 'deterministic',
    message: cleanMessage,
    actions,
    suggestedQuestions,
    notice,
    privacy: buildPrivacyMetadata(),
    contactFlow: null
  };
}

async function maybeModelAssist(question, state, context) {
  const q = normalizeQuestion(question);
  if (!q || q.length < 8) {
    return null;
  }

  if (state && state.turnCount > 8) {
    return null;
  }

  const deployment = process.env.KEYR_CONCIERGE_DEPLOYMENT || process.env.KEYR_COACH_FAST_DEPLOYMENT || 'gpt-5-mini';
  const OpenAI = require('openai');
  const apiKey = process.env.AZURE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_AI_ENDPOINT;

  if (!apiKey || !endpoint) {
    return null;
  }

  const client = new OpenAI({
    apiKey,
    baseURL: endpoint,
    defaultQuery: { 'api-version': process.env.AZURE_OPENAI_API_VERSION || '2024-10-21' },
    defaultHeaders: {
      'api-key': apiKey
    }
  });

  try {
    const completion = await client.responses.create({
      model: deployment,
      input: [{ role: 'user', content: `You are KEYR Concierge. Answer using only approved public facts. Return valid JSON with fields: message, factsUsed, actionRouteIds, suggestedQuestions, needsClarification, clarifyingQuestion, confidence. Do not invent facts, URLs, approval outcomes, or account information.\nQuestion: ${q}` }],
      response_format: { type: 'json_schema', json_schema: { name: 'keyr_concierge', schema: { type: 'object', properties: { message: { type: 'string' }, factsUsed: { type: 'array', items: { type: 'string' } }, actionRouteIds: { type: 'array', items: { type: 'string' } }, suggestedQuestions: { type: 'array', items: { type: 'string' } }, needsClarification: { type: 'boolean' }, clarifyingQuestion: { type: ['string', 'null'] }, confidence: { type: 'number' } }, required: ['message', 'factsUsed', 'actionRouteIds', 'suggestedQuestions', 'needsClarification', 'clarifyingQuestion', 'confidence'], additionalProperties: false } } }
    });

    const text = completion?.output_text || completion?.output?.[0]?.content?.[0]?.text || null;
    if (!text) {
      return null;
    }

    const parsed = JSON.parse(text);
    const validation = validateModelResponse(parsed, ['keyr_overview', 'anchor_overview', 'ascend_overview', 'apex_overview', 'safe_start_overview', 'pricing_overview', 'public_agent_limits', 'contact_process', 'keyr_mission'], ['explore', 'pricing', 'faq', 'apply', 'contact', 'privacy', 'terms', 'security']);
    if (!validation.valid) {
      return null;
    }

    return {
      ...parsed,
      answerSource: 'model',
      agent: 'KEYR Concierge'
    };
  } catch (error) {
    return null;
  }
}

function createContactFlowState(overrides = {}) {
  const now = new Date().toISOString();
  return {
    status: 'collecting',
    nextField: 'name',
    collectedFields: [],
    topicRoutingKey: null,
    consent: undefined,
    source: 'KEYR Concierge',
    createdAtUtc: now,
    updatedAtUtc: now,
    data: {},
    ...overrides
  };
}

function normalizeContactInput(input = {}) {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const normalized = {};
  const candidate = {
    name: String(input.name || '').trim(),
    email: String(input.email || '').trim(),
    phone: String(input.phone || '').trim(),
    organization: String(input.organization || '').trim(),
    topic: String(input.topic || '').trim(),
    message: String(input.message || '').trim(),
    consent: input.consent
  };

  if (candidate.name) normalized.name = candidate.name;
  if (candidate.email) normalized.email = candidate.email.toLowerCase();
  if (candidate.phone) normalized.phone = candidate.phone;
  if (candidate.organization) normalized.organization = candidate.organization;
  if (candidate.topic) normalized.topic = candidate.topic;
  if (candidate.message) normalized.message = candidate.message;
  if (candidate.consent === true || candidate.consent === false) normalized.consent = Boolean(candidate.consent);
  return normalized;
}

function getCurrentContactFlowState(state) {
  if (!state || !state.contactFlowState || typeof state.contactFlowState !== 'object') {
    return null;
  }

  const flow = state.contactFlowState;
  if (flow.status === 'submitted' || flow.status === 'cancelled') {
    return null;
  }

  return flow;
}

function hasActiveContactFlow(state) {
  const flow = getCurrentContactFlowState(state);
  if (!flow) {
    return false;
  }

  return ['collecting', 'awaiting_consent', 'failed'].includes(flow.status);
}

function isCancellationRequest(question) {
  const q = normalizeQuestion(question).toLowerCase();
  return [
    'cancel my contact request',
    'never mind',
    'stop the contact request',
    'i do not want to submit this'
  ].some((phrase) => q.includes(phrase));
}

function mergeContactFlowData(existingFlow, incomingData) {
  const prior = existingFlow && existingFlow.data && typeof existingFlow.data === 'object' ? { ...existingFlow.data } : {};
  const merged = { ...prior, ...incomingData };
  const collectedFields = [];
  if (merged.name) collectedFields.push('name');
  if (merged.email) collectedFields.push('email');
  if (merged.phone) collectedFields.push('phone');
  if (merged.organization) collectedFields.push('organization');
  if (merged.topic) collectedFields.push('topic');
  if (merged.message) collectedFields.push('message');
  if (merged.consent !== undefined) collectedFields.push('consent');
  return { merged, collectedFields: Array.from(new Set(collectedFields)) };
}

function buildContactFlowProgress(state, flow, data, status, nextField, message, actions = []) {
  const nextFlow = {
    ...createContactFlowState({
      status,
      nextField,
      collectedFields: flow && Array.isArray(flow.collectedFields) ? flow.collectedFields : [],
      topicRoutingKey: flow && flow.topicRoutingKey ? flow.topicRoutingKey : null,
      consent: data && data.consent !== undefined ? Boolean(data.consent) : undefined,
      source: 'KEYR Concierge',
      data: { ...(flow && flow.data ? flow.data : {}), ...data },
      createdAtUtc: flow && flow.createdAtUtc ? flow.createdAtUtc : new Date().toISOString(),
      updatedAtUtc: new Date().toISOString()
    }),
    ...flow,
    status,
    nextField,
    consent: data && data.consent !== undefined ? Boolean(data.consent) : undefined,
    source: 'KEYR Concierge',
    data: { ...(flow && flow.data ? flow.data : {}), ...data },
    updatedAtUtc: new Date().toISOString()
  };

  nextFlow.collectedFields = Array.from(new Set([...(flow && Array.isArray(flow.collectedFields) ? flow.collectedFields : []), ...(nextFlow.data ? Object.keys(nextFlow.data).filter((key) => nextFlow.data[key] !== undefined && nextFlow.data[key] !== null && nextFlow.data[key] !== '') : [])]));
  return {
    flow: nextFlow,
    response: {
      success: true,
      agent: 'KEYR Concierge',
      conversationId: state.conversationId,
      intent: 'CONTACT',
      answerSource: 'deterministic',
      message,
      actions,
      suggestedQuestions: [],
      notice: 'Public website information only.',
      privacy: buildPrivacyMetadata(),
      contactFlow: {
        status: nextFlow.status,
        nextField: nextFlow.nextField,
        collectedFields: nextFlow.collectedFields,
        topicRoutingKey: nextFlow.topicRoutingKey || null,
        consent: nextFlow.consent,
        source: 'KEYR Concierge',
        createdAtUtc: nextFlow.createdAtUtc,
        updatedAtUtc: nextFlow.updatedAtUtc
      }
    }
  };
}

async function processConciergeRequest(payload, requestInfo = {}) {
  const requestBody = payload || {};
  const validation = validateRequestBody(requestBody);
  if (!validation.valid) {
    return {
      status: 400,
      jsonBody: {
        success: false,
        error: validation.error || 'Invalid request.'
      }
    };
  }

  const suppliedConversationId = normalizeConversationId(requestBody.conversationId);
  const conversationId = suppliedConversationId || generateConversationId();
  const state = suppliedConversationId ? resolveConversationState(conversationId) : ensureConversationState(conversationId);
  const question = sanitizeText(requestBody.question);
  const normalizedContactInput = normalizeContactInput(requestBody.contactInput || {});
  const hasContactInput = Object.keys(normalizedContactInput).length > 0;
  const activeFlow = getCurrentContactFlowState(state);

  if (activeFlow && isCancellationRequest(question)) {
    const cancelledFlow = {
      ...activeFlow,
      status: 'cancelled',
      nextField: null,
      consent: false,
      updatedAtUtc: new Date().toISOString()
    };
    updateConversationState(state, { contactFlowState: cancelledFlow, previousIntent: 'CONTACT', activeTopic: 'contact', turnCount: (state.turnCount || 0) + 1 });
    return {
      status: 200,
      jsonBody: {
        success: true,
        agent: 'KEYR Concierge',
        conversationId: state.conversationId,
        intent: 'CONTACT',
        answerSource: 'deterministic',
        message: 'Your contact request has been cancelled. No message was sent.',
        actions: [buildAction('Contact', 'contact')].filter(Boolean),
        suggestedQuestions: ['I want to ask a product question.', 'How do I apply?'],
        notice: 'Public website information only.',
        privacy: buildPrivacyMetadata(),
        contactFlow: {
          status: 'cancelled',
          nextField: null,
          collectedFields: Array.isArray(cancelledFlow.collectedFields) ? cancelledFlow.collectedFields : [],
          topicRoutingKey: cancelledFlow.topicRoutingKey || null,
          consent: false,
          source: 'KEYR Concierge',
          createdAtUtc: cancelledFlow.createdAtUtc,
          updatedAtUtc: cancelledFlow.updatedAtUtc
        }
      }
    };
  }

  if (isCancellationRequest(question)) {
    const cancelledFlow = {
      ...(activeFlow || createContactFlowState()),
      status: 'cancelled',
      nextField: null,
      consent: false,
      collectedFields: Array.isArray((activeFlow || {}).collectedFields) ? (activeFlow || {}).collectedFields : [],
      updatedAtUtc: new Date().toISOString()
    };
    updateConversationState(state, { contactFlowState: cancelledFlow, previousIntent: 'CONTACT', activeTopic: 'contact', turnCount: (state.turnCount || 0) + 1 });
    return {
      status: 200,
      jsonBody: {
        success: true,
        agent: 'KEYR Concierge',
        conversationId: state.conversationId,
        intent: 'CONTACT',
        answerSource: 'deterministic',
        message: 'Your contact request has been cancelled. No message was sent.',
        actions: [buildAction('Contact', 'contact')].filter(Boolean),
        suggestedQuestions: ['I want to ask a product question.', 'How do I apply?'],
        notice: 'Public website information only.',
        privacy: buildPrivacyMetadata(),
        contactFlow: {
          status: 'cancelled',
          nextField: null,
          collectedFields: cancelledFlow.collectedFields,
          topicRoutingKey: cancelledFlow.topicRoutingKey || null,
          consent: false,
          source: 'KEYR Concierge',
          createdAtUtc: cancelledFlow.createdAtUtc,
          updatedAtUtc: cancelledFlow.updatedAtUtc
        }
      }
    };
  }

  if (hasActiveContactFlow(state) || hasContactInput || /contact/i.test(question) || /someone to contact me|submit my contact request|i want to speak with someone|contact me/i.test(question)) {
    const baseFlow = activeFlow || createContactFlowState({
      status: 'collecting',
      nextField: 'name',
      collectedFields: [],
      topicRoutingKey: null,
      consent: undefined,
      source: 'KEYR Concierge',
      data: {}
    });

    const mergedData = { ...(baseFlow.data || {}), ...normalizedContactInput };
    const combinedText = `${mergedData.name || ''} ${mergedData.email || ''} ${mergedData.phone || ''} ${mergedData.organization || ''} ${mergedData.topic || ''} ${mergedData.message || ''}`;

    if (hasSensitivePattern(combinedText)) {
      return {
        status: 400,
        jsonBody: {
          success: false,
          agent: 'KEYR Concierge',
          conversationId: state.conversationId,
          intent: 'CONTACT',
          error: 'Please do not include sensitive financial information in this public contact form.'
        }
      };
    }

    if (mergedData.email && !isValidEmail(mergedData.email)) {
      const failedFlow = { ...baseFlow, status: 'failed', nextField: 'email', data: mergedData, consent: false, updatedAtUtc: new Date().toISOString() };
      updateConversationState(state, { contactFlowState: failedFlow, previousIntent: 'CONTACT', activeTopic: 'contact', turnCount: (state.turnCount || 0) + 1 });
      return {
        status: 400,
        jsonBody: {
          success: false,
          agent: 'KEYR Concierge',
          conversationId: state.conversationId,
          intent: 'CONTACT',
          error: 'Please provide a valid email address.'
        }
      };
    }

    if (!mergedData.name) {
      const updatedFlow = { ...baseFlow, status: 'collecting', nextField: 'name', data: mergedData, consent: undefined, updatedAtUtc: new Date().toISOString() };
      updateConversationState(state, { contactFlowState: updatedFlow, previousIntent: 'CONTACT', activeTopic: 'contact', turnCount: (state.turnCount || 0) + 1 });
      return {
        status: 200,
        jsonBody: {
          success: true,
          agent: 'KEYR Concierge',
          conversationId: state.conversationId,
          intent: 'CONTACT',
          answerSource: 'deterministic',
          message: 'I can help connect you with the right KEYR team. Please provide your name so I can start the contact request.',
          actions: [buildAction('Contact', 'contact')].filter(Boolean),
          suggestedQuestions: ['I want to ask a product question.', 'I need help with the website.'],
          notice: 'Public website information only.',
          privacy: buildPrivacyMetadata(),
          contactFlow: {
            status: 'collecting',
            nextField: 'name',
            collectedFields: Array.isArray(updatedFlow.collectedFields) ? updatedFlow.collectedFields : [],
            topicRoutingKey: updatedFlow.topicRoutingKey || null,
            consent: undefined,
            source: 'KEYR Concierge',
            createdAtUtc: updatedFlow.createdAtUtc,
            updatedAtUtc: updatedFlow.updatedAtUtc
          }
        }
      };
    }

    if (!mergedData.email) {
      const updatedFlow = { ...baseFlow, status: 'collecting', nextField: 'email', data: mergedData, consent: undefined, updatedAtUtc: new Date().toISOString() };
      updateConversationState(state, { contactFlowState: updatedFlow, previousIntent: 'CONTACT', activeTopic: 'contact', turnCount: (state.turnCount || 0) + 1 });
      return {
        status: 200,
        jsonBody: {
          success: true,
          agent: 'KEYR Concierge',
          conversationId: state.conversationId,
          intent: 'CONTACT',
          answerSource: 'deterministic',
          message: 'Thanks. What email address should we use to reach you?',
          actions: [],
          suggestedQuestions: [],
          notice: 'Public website information only.',
          privacy: buildPrivacyMetadata(),
          contactFlow: {
            status: 'collecting',
            nextField: 'email',
            collectedFields: Array.isArray(updatedFlow.collectedFields) ? updatedFlow.collectedFields : [],
            topicRoutingKey: updatedFlow.topicRoutingKey || null,
            consent: updatedFlow.consent,
            source: 'KEYR Concierge',
            createdAtUtc: updatedFlow.createdAtUtc,
            updatedAtUtc: updatedFlow.updatedAtUtc
          }
        }
      };
    }

    if (!mergedData.topic || !CONTACT_TOPIC_OPTIONS.includes(mergedData.topic)) {
      const updatedFlow = { ...baseFlow, status: 'collecting', nextField: 'topic', data: mergedData, topicRoutingKey: mergedData.topic || null, consent: mergedData.consent, updatedAtUtc: new Date().toISOString() };
      updateConversationState(state, { contactFlowState: updatedFlow, previousIntent: 'CONTACT', activeTopic: 'contact', turnCount: (state.turnCount || 0) + 1 });
      return {
        status: 200,
        jsonBody: {
          success: true,
          agent: 'KEYR Concierge',
          conversationId: state.conversationId,
          intent: 'CONTACT',
          answerSource: 'deterministic',
          message: 'What topic best matches your question?',
          actions: [],
          suggestedQuestions: [],
          notice: 'Public website information only.',
          privacy: buildPrivacyMetadata(),
          contactFlow: {
            status: 'collecting',
            nextField: 'topic',
            collectedFields: Array.isArray(updatedFlow.collectedFields) ? updatedFlow.collectedFields : [],
            topicRoutingKey: updatedFlow.topicRoutingKey || null,
            consent: updatedFlow.consent,
            source: 'KEYR Concierge',
            createdAtUtc: updatedFlow.createdAtUtc,
            updatedAtUtc: updatedFlow.updatedAtUtc
          }
        }
      };
    }

    if (!mergedData.message) {
      const updatedFlow = { ...baseFlow, status: 'collecting', nextField: 'message', data: mergedData, consent: mergedData.consent, updatedAtUtc: new Date().toISOString() };
      updateConversationState(state, { contactFlowState: updatedFlow, previousIntent: 'CONTACT', activeTopic: 'contact', turnCount: (state.turnCount || 0) + 1 });
      return {
        status: 200,
        jsonBody: {
          success: true,
          agent: 'KEYR Concierge',
          conversationId: state.conversationId,
          intent: 'CONTACT',
          answerSource: 'deterministic',
          message: 'Please share a brief message about how we can help.',
          actions: [],
          suggestedQuestions: [],
          notice: 'Public website information only.',
          privacy: buildPrivacyMetadata(),
          contactFlow: {
            status: 'collecting',
            nextField: 'message',
            collectedFields: Array.isArray(updatedFlow.collectedFields) ? updatedFlow.collectedFields : [],
            topicRoutingKey: updatedFlow.topicRoutingKey || null,
            consent: updatedFlow.consent,
            source: 'KEYR Concierge',
            createdAtUtc: updatedFlow.createdAtUtc,
            updatedAtUtc: updatedFlow.updatedAtUtc
          }
        }
      };
    }

    if (mergedData.consent !== true) {
      const updatedFlow = { ...baseFlow, status: 'awaiting_consent', nextField: 'consent', data: mergedData, consent: false, updatedAtUtc: new Date().toISOString() };
      updateConversationState(state, { contactFlowState: updatedFlow, previousIntent: 'CONTACT', activeTopic: 'contact', turnCount: (state.turnCount || 0) + 1 });
      return {
        status: 200,
        jsonBody: {
          success: true,
          agent: 'KEYR Concierge',
          conversationId: state.conversationId,
          intent: 'CONTACT',
          answerSource: 'deterministic',
          message: `Before I submit your request, please confirm that you authorize KEYR to use the information provided to respond to your inquiry. ${SENSITIVE_DATA_WARNING}`,
          actions: [buildAction('Contact', 'contact')].filter(Boolean),
          suggestedQuestions: [],
          notice: 'Public website information only.',
          privacy: buildPrivacyMetadata(),
          contactFlow: {
            status: 'awaiting_consent',
            nextField: 'consent',
            collectedFields: Array.isArray(updatedFlow.collectedFields) ? updatedFlow.collectedFields : [],
            topicRoutingKey: updatedFlow.topicRoutingKey || null,
            consent: false,
            source: 'KEYR Concierge',
            createdAtUtc: updatedFlow.createdAtUtc,
            updatedAtUtc: updatedFlow.updatedAtUtc
          }
        }
      };
    }

    const submitContactRequest = getSubmitContactRequest();
    const submission = await submitContactRequest({
      name: mergedData.name,
      email: mergedData.email,
      phone: mergedData.phone,
      organization: mergedData.organization,
      topic: mergedData.topic,
      message: mergedData.message,
      consent: true,
      source: 'KEYR Concierge'
    });

    const finalFlow = {
      ...baseFlow,
      status: submission && submission.stored ? 'received' : 'failed',
      nextField: submission && submission.stored ? null : 'consent',
      data: { ...mergedData, consent: true },
      consent: true,
      updatedAtUtc: new Date().toISOString()
    };
    updateConversationState(state, { contactFlowState: finalFlow, previousIntent: 'CONTACT', activeTopic: 'contact', turnCount: (state.turnCount || 0) + 1 });

    if (!submission || !submission.ok || !submission.stored) {
      return {
        status: 200,
        jsonBody: {
          success: true,
          agent: 'KEYR Concierge',
          conversationId: state.conversationId,
          intent: 'CONTACT',
          answerSource: 'deterministic',
          message: 'I could not submit your contact request right now. Please try again later or use the Contact page.',
          actions: [buildAction('Contact', 'contact')].filter(Boolean),
          suggestedQuestions: ['How do I contact KEYR?', 'What is KEYR?'],
          notice: 'Public website information only.',
          privacy: buildPrivacyMetadata(),
          contactFlow: {
            status: 'failed',
            deliveryStatus: 'failed',
            nextField: 'consent',
            collectedFields: Array.isArray(finalFlow.collectedFields) ? finalFlow.collectedFields : [],
            topicRoutingKey: finalFlow.topicRoutingKey || null,
            consent: true,
            source: 'KEYR Concierge',
            createdAtUtc: finalFlow.createdAtUtc,
            updatedAtUtc: finalFlow.updatedAtUtc
          }
        }
      };
    }

    return {
      status: 200,
      jsonBody: {
        success: true,
        agent: 'KEYR Concierge',
        conversationId: state.conversationId,
        intent: 'CONTACT',
        answerSource: 'deterministic',
        message: `Your request has been received and saved. Reference ID: ${submission.referenceId}. A KEYR team member will review it and follow up if needed.`,
        actions: [buildAction('Contact', 'contact'), buildAction('Explore Products', 'explore')].filter(Boolean),
        suggestedQuestions: ['What is KEYR?', 'How do I apply?'],
        notice: 'Public website information only.',
        privacy: buildPrivacyMetadata(),
        contactFlow: {
          status: 'received',
          deliveryStatus: 'stored_only',
          nextField: null,
          collectedFields: Array.isArray(finalFlow.collectedFields) ? finalFlow.collectedFields : [],
          topicRoutingKey: finalFlow.topicRoutingKey || null,
          consent: true,
          source: 'KEYR Concierge',
          referenceId: submission.referenceId,
          createdAtUtc: finalFlow.createdAtUtc,
          updatedAtUtc: finalFlow.updatedAtUtc
        }
      }
    };
  }

  const intent = classifyIntent(question, state);
  const nextState = updateConversationState(state, {
    previousIntent: state.previousIntent || intent,
    turnCount: (state.turnCount || 0) + 1,
    activeTopic: intent,
    updatedAtUtc: new Date().toISOString()
  });

  const base = { conversationId: nextState.conversationId, intent, question };

  if (intent === 'AGENT_IDENTITY') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: AGENT_IDENTITY_RESPONSE,
        actions: getActionListForIntent(intent),
        suggestedQuestions: ['What is KEYR?', 'What can you do?']
      })
    };
  }

  if (intent === 'AGENT_CAPABILITIES') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: AGENT_CAPABILITIES_RESPONSE,
        actions: getActionListForIntent(intent),
        suggestedQuestions: ['What is Anchor?', 'How do I apply?']
      })
    };
  }

  if (intent === 'FINANCIAL_COACH_DIFFERENTIATION') {
    const selection = question.toLowerCase().includes('what is the financial coach') ? 'What is the Financial Coach?' : (question.toLowerCase().includes('does keyr have two ai agents') ? 'Does KEYR have two AI agents?' : 'Are you the Financial Coach?');
    const message = FINANCIAL_COACH_DIFFERENTIATION[selection] || FINANCIAL_COACH_DIFFERENTIATION['Are you the Financial Coach?'];
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message,
        actions: getActionListForIntent(intent),
        suggestedQuestions: ['What is KEYR?', 'How can I contact KEYR?']
      })
    };
  }

  if (intent === 'CURRENT_DATE') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: `Today is ${getCurrentDateChicago()}.`,
        actions: getActionListForIntent('AGENT_IDENTITY'),
        suggestedQuestions: ['What is KEYR?', 'What is Anchor?']
      })
    };
  }

  if (intent === 'FOUNDER') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: 'KEYR was founded by a public-interest-minded entrepreneur rooted in Oklahoma.',
        actions: getActionListForIntent('AGENT_IDENTITY'),
        suggestedQuestions: ['Where is KEYR based?', 'What is KEYR?']
      })
    };
  }

  if (intent === 'BUSINESS_LOCATION') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: 'KEYR is based in Oklahoma, with roots in Oklahoma City and Edmond. It is an Oklahoma company with a public business presence in the state.',
        actions: getActionListForIntent('AGENT_IDENTITY'),
        suggestedQuestions: ['Who founded KEYR?', 'What is KEYR?']
      })
    };
  }

  if (intent === 'KEYR_OVERVIEW') {
    const knowledge = getPublicKnowledge().find((entry) => entry.id === 'keyr_overview');
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: knowledge ? knowledge.content : 'KEYR is a financial technology company focused on building a better financial foundation through education, credit-building, and debt-reduction support.',
        actions: [buildAction('Explore Products', 'explore'), buildAction('View Pricing', 'pricing')].filter(Boolean),
        suggestedQuestions: ['What is Anchor?', 'What is Ascend?', 'What is Apex?']
      })
    };
  }

  if (intent === 'SAFE_START') {
    const safeStartMessage = 'Safe Start is an optional readiness experience. It is not a card, not an account, not an application result, and not a fourth product or guaranteed progression stage.';
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: safeStartMessage,
        actions: [buildAction('Explore Products', 'explore'), buildAction('How It Works', 'how_it_works')].filter(Boolean),
        suggestedQuestions: ['What is Anchor?', 'What is Apex?']
      })
    };
  }

  if (intent === 'AUTO_PAY_ADVANTAGE') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: 'AutoPay Advantage is a public program feature intended to support consistent, on-time payment habits and guided financial responsibility.',
        actions: [buildAction('Explore Products', 'explore'), buildAction('View Pricing', 'pricing')].filter(Boolean),
        suggestedQuestions: ['What is Anchor?', 'What is Ascend?']
      })
    };
  }

  if (intent === 'PRODUCT_OVERVIEW') {
    const productName = getProductNameFromQuestion(question, nextState) || 'Anchor';
    const overview = getApprovedProductOverview(productName);
    const message = overview ? overview.short : 'KEYR offers public product information about Anchor, Ascend, and Apex, each subject to eligibility, approval, and applicable program terms.';
    nextState.currentKeyrProduct = productName;
    updateConversationState(nextState, { currentKeyrProduct: productName, previousIntent: intent, activeTopic: productName });
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent: 'PRODUCT_OVERVIEW',
        message,
        actions: [buildAction('Explore Products', 'explore'), buildAction('View Pricing', 'pricing'), buildAction('Apply', 'apply')].filter(Boolean),
        suggestedQuestions: ['How is it different from Chime?', 'How do I apply?']
      })
    };
  }

  if (intent === 'COMPARISON') {
    const state = nextState;
    const relevantProduct = state.currentKeyrProduct || 'Anchor';
    const comparisonEntities = buildComparisonEntities(question, state);
    const names = Array.from(new Set([relevantProduct, ...comparisonEntities]));
    const qLower = question.toLowerCase();

    if ((qLower.includes('different parts of keyr') || qLower.includes('how do the products work') || qLower.includes('how do the products differ') || (qLower.includes('explain') && qLower.includes('keyr')) || qLower.includes('help me understand') || qLower.includes('what are the differences between keyr')) && !/will i qualify|am i eligible|can i get approved|do i meet the requirements|do i qualify|am i approved|will i be approved/.test(qLower)) {
      const message = 'Anchor is KEYR\'s general credit-building product, designed to support stronger habits and responsible financial progress. Ascend is KEYR\'s debt-reduction-focused path, intended to help members reduce expensive debt and improve cash flow habits. Apex is KEYR\'s premium debt-reduction path, designed for a more advanced stage of the journey. These products are meant to serve different needs and stages, and this explanation is informational only; it does not determine eligibility, approval, or qualification.';
      updateConversationState(state, { currentKeyrProduct: relevantProduct, comparisonEntities: ['Anchor', 'Ascend', 'Apex'], previousIntent: intent, activeTopic: 'comparison' });
      return {
        status: 200,
        jsonBody: createApprovedResponse({
          conversationId: state.conversationId,
          intent: 'COMPARISON',
          message,
          actions: [buildAction('Explore Products', 'explore'), buildAction('View Pricing', 'pricing'), buildAction('Apply', 'apply')].filter(Boolean),
          suggestedQuestions: ['What is Anchor?', 'What is Ascend?', 'What is Apex?']
        })
      };
    }

    if (qLower.includes('unsecured') && qLower.includes('path')) {
      const message = "Anchor is KEYR's secured credit-building product. KEYR's proposed model may allow a member to apply for Ascend or Apex in the future, subject to approval, underwriting, product availability, and program terms. Progression is not automatic. For Chime, I do not have sufficiently current approved information to confirm that provider's current unsecured progression policy. For Discover, I do not have sufficiently current approved information to confirm that provider's current unsecured progression policy. Current terms vary, review official disclosures before deciding, and no provider or progression is guaranteed.";
      updateConversationState(state, { currentKeyrProduct: relevantProduct, comparisonEntities: ['Chime', 'Discover'], previousIntent: intent, activeTopic: 'comparison' });
      return {
        status: 200,
        jsonBody: createApprovedResponse({
          conversationId: state.conversationId,
          intent: 'COMPARISON',
          message,
          actions: [buildAction('Explore Products', 'explore'), buildAction('View Pricing', 'pricing'), buildAction('Apply', 'apply')].filter(Boolean),
          suggestedQuestions: ['What is KEYR?', 'What is Anchor?', 'How do I apply?']
        })
      };
    }

    if (qLower.includes('chime') || qLower.includes('discover')) {
      const competitorName = qLower.includes('discover') ? 'Discover' : 'Chime';
      const profile = getCompetitorProfile(competitorName);
      const mergedComparisonEntities = Array.from(new Set([...(state.comparisonEntities || []), competitorName]));
      if (profile && isCompetitorFresh(profile)) {
        let message = '';
        if (competitorName === 'Chime') {
          message = "Different products are designed for different needs. Anchor is KEYR's proposed secured credit-building product within a broader three-product model that may provide future opportunities to apply for Ascend or Apex, subject to approval and applicable program terms. Chime's public product structure differs from Anchor's proposed secured credit-building model and uses its own account requirements. Because competitor features and terms can change, review Chime's current official disclosures before deciding.";
        } else {
          message = "Anchor is KEYR's proposed secured credit-building product within a broader product path. Discover offers its own credit-card products with different product structures and pricing approaches. The products differ in structure, pricing, features, and potential account-development paths. Review each provider's current disclosures before deciding.";
        }
        updateConversationState(state, { currentKeyrProduct: relevantProduct, comparisonEntities: mergedComparisonEntities, previousIntent: intent, activeTopic: 'comparison' });
        return {
          status: 200,
          jsonBody: createApprovedResponse({
            conversationId: state.conversationId,
            intent: 'COMPARISON',
            message,
            actions: [buildAction('Explore Products', 'explore'), buildAction('View Pricing', 'pricing'), buildAction('Apply', 'apply')].filter(Boolean),
            suggestedQuestions: ['What is KEYR?', 'Compare Anchor, Ascend, and Apex.']
          })
        };
      }
      return {
        status: 200,
        jsonBody: createApprovedResponse({
          conversationId: state.conversationId,
          intent: 'COMPARISON',
          message: 'I do not have sufficiently current approved information to confirm that provider\'s current unsecured progression policy. Current terms vary, and review of that provider\'s official disclosures is recommended before deciding.',
          actions: [buildAction('Explore Products', 'explore'), buildAction('View Pricing', 'pricing'), buildAction('Contact', 'contact')].filter(Boolean),
          suggestedQuestions: ['What is Anchor?', 'What is Apex?']
        })
      };
    }

    const productSummary = relevantProduct === 'Anchor'
      ? 'Anchor is a secured credit-building product designed to support responsible habits and product progression.'
      : relevantProduct === 'Ascend'
        ? 'Ascend is an unsecured product designed for practical credit-building and debt-reduction support.'
        : 'Apex is a premium unsecured product designed for a more advanced stage of the financial journey.';

    updateConversationState(state, { currentKeyrProduct: relevantProduct, comparisonEntities: names.slice(1), previousIntent: intent, activeTopic: 'comparison' });
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: state.conversationId,
        intent: 'COMPARISON',
        message: `${productSummary} Different products are designed for different needs. KEYR's approach focuses on guided progress, credit-building, debt-reduction support, and education.`,
        actions: [buildAction('Explore Products', 'explore'), buildAction('View Pricing', 'pricing'), buildAction('FAQs', 'faq')].filter(Boolean),
        suggestedQuestions: ['What is KEYR?', 'How is KEYR different?', 'Compare Anchor, Ascend, and Apex.']
      })
    };
  }

  if (intent === 'APPLY') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: 'You can start by visiting the Apply page to learn more about KEYR products and the application process. Eligibility, approval, underwriting, and product availability remain subject to program requirements and final disclosures.',
        actions: [buildAction('Apply', 'apply'), buildAction('Explore Products', 'explore')].filter(Boolean),
        suggestedQuestions: ['What is Anchor?', 'What is Apex?']
      })
    };
  }

  if (intent === 'NAVIGATION') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: 'You can review KEYR pages such as Explore, Pricing, FAQs, Education, How It Works, Apply, and Contact for public information.',
        actions: NAVIGATION_ALLOWLIST.slice(1, 8).map((entry) => ({ label: entry.label, routeId: entry.routeId, url: entry.url })),
        suggestedQuestions: ['What is KEYR?', 'How do I apply?']
      })
    };
  }

  if (intent === 'PRIVACY') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: `${PRIVACY_NOTICE} ${SENSITIVE_DATA_WARNING} ${CONSENT_NOTICE}`,
        actions: [buildAction('Privacy Policy', 'privacy'), buildAction('Terms of Use', 'terms'), buildAction('Security', 'security')].filter(Boolean),
        suggestedQuestions: ['What is KEYR?', 'How can I contact KEYR?']
      })
    };
  }

  if (intent === 'ACCOUNT_BOUNDARY') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: 'I can help with general information about KEYR, but I cannot access personal account details. Secure member services will handle authenticated account information when available.',
        actions: [buildAction('Explore Products', 'explore'), buildAction('Contact', 'contact')].filter(Boolean),
        suggestedQuestions: ['What is KEYR?', 'What is Anchor?']
      })
    };
  }

  if (intent === 'ELIGIBILITY') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: 'I cannot determine or guarantee approval. Eligibility depends on verified information, underwriting, product availability, and applicable program requirements. I can explain Apex or help you open the application page.',
        actions: [buildAction('Apply', 'apply'), buildAction('Explore Products', 'explore')].filter(Boolean),
        suggestedQuestions: ['What is Apex?', 'How do I apply?']
      })
    };
  }

  if (intent === 'PERSONALIZED_PLAN') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: 'I can explain KEYR\'s public balance-transfer approach, but I cannot create a personalized plan through the public website. Personalized guidance requires verified information and a secure member experience.',
        actions: [buildAction('Explore Products', 'explore'), buildAction('View Pricing', 'pricing')].filter(Boolean),
        suggestedQuestions: ['What is KEYR?', 'How does KEYR help with debt reduction?']
      })
    };
  }

  if (intent === 'SENSITIVE_DATA_WARNING') {
    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent,
        message: 'For your security, please do not share account numbers, passwords, card numbers, bank information, Social Security numbers, or other sensitive personal information here.',
        actions: [buildAction('Privacy Policy', 'privacy'), buildAction('Contact', 'contact')].filter(Boolean),
        suggestedQuestions: ['What is KEYR?', 'How can I contact KEYR?']
      })
    };
  }

  if (intent === 'UNCERTAIN') {
    const modelResponse = await maybeModelAssist(question, nextState, requestInfo);
    if (modelResponse && modelResponse.message) {
      const cleanedMessage = sanitizePublicResponseText(String(modelResponse.message || '').slice(0, 2000), 'I can help with general information about KEYR, but I do not have sufficiently approved information for that question.');
      const normalized = {
        success: true,
        agent: 'KEYR Concierge',
        conversationId: nextState.conversationId,
        intent: 'UNCERTAIN',
        answerSource: 'model',
        message: cleanedMessage,
        actions: Array.isArray(modelResponse.actionRouteIds) ? modelResponse.actionRouteIds.map((routeId) => buildAction(routeId, routeId)).filter(Boolean) : [buildAction('Explore Products', 'explore')],
        suggestedQuestions: Array.isArray(modelResponse.suggestedQuestions) ? modelResponse.suggestedQuestions.slice(0, 4) : DEFAULT_SUGGESTED_QUESTIONS,
        notice: 'Public website information only.',
        privacy: buildPrivacyMetadata(),
        contactFlow: null
      };
      return { status: 200, jsonBody: normalized };
    }

    return {
      status: 200,
      jsonBody: createApprovedResponse({
        conversationId: nextState.conversationId,
        intent: 'UNCERTAIN',
        message: 'I can help with general information about KEYR, but I do not have sufficiently approved information for that question. I can explain KEYR products, discuss public pages, or connect you with the KEYR team.',
        actions: [buildAction('Explore Products', 'explore'), buildAction('Contact', 'contact'), buildAction('FAQs', 'faq')].filter(Boolean),
        suggestedQuestions: ['What is KEYR?', 'How do I apply?', 'How can I contact KEYR?']
      })
    };
  }

  return {
    status: 200,
    jsonBody: createApprovedResponse({
      conversationId: nextState.conversationId,
      intent: 'AGENT_IDENTITY',
      message: AGENT_IDENTITY_RESPONSE,
      actions: getActionListForIntent('AGENT_IDENTITY'),
      suggestedQuestions: ['What is KEYR?', 'How can I contact KEYR?']
    })
  };
}

module.exports = {
  processConciergeRequest,
  classifyIntent,
  buildAction,
  getCurrentDateChicago,
  buildComparisonEntities,
  getProductNameFromQuestion,
  normalizeQuestion,
  setSubmitContactRequest
};
