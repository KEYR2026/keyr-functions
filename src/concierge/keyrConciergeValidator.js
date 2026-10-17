const { ALLOWED_ROUTE_IDS } = require('./keyrNavigationMap');
const { getCompetitorProfile } = require('./keyrCompetitorKnowledge');

const ALLOWED_TOPICS = new Set([
  'General Information',
  'Product Question',
  'Application Assistance',
  'Technical Website Issue',
  'Bank or Program Partnership',
  'Employer or University Partnership',
  'Community or Nonprofit Partnership',
  'Grant or Funding Opportunity',
  'Investment Inquiry',
  'Press or Media',
  'Privacy or Security',
  'Other'
]);

function sanitizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hasSensitivePattern(value) {
  const text = String(value || '');
  const patterns = [
    /\b\d{3}-\d{2}-\d{4}\b/, // SSN with dashes
    /\b\d{9}\b/, // SSN-ish
    /\b\d{16}\b/, // card-like
    /\b(?:\d[ -]?){13,19}\b/, // long digits perhaps card
    /\b(?:password|passwd|pwd)\b/i,
    /\b(?:account number|routing number|bank account|card number)\b/i
  ];
  return patterns.some((pattern) => pattern.test(text));
}

const PROHIBITED_ENCODING_ARTIFACTS = [/â/gi, /�/g, /€|™/g, /â€™/gi, /â€˜/gi, /â€œ/gi, /â€/gi, /â€+/gi];

function normalizePublicText(value) {
  let text = String(value ?? '');
  text = text.replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/[\u2026]/g, '...')
    .replace(/â€™/gi, "'")
    .replace(/â€˜/gi, "'")
    .replace(/â€œ/gi, '"')
    .replace(/â€/gi, '"')
    .replace(/â€+/gi, '')
    .replace(/â(?=[A-Za-z])/gi, 'a')
    .replace(/â/g, '')
    .replace(/[€™]/g, '');
  return text;
}

function hasProhibitedEncodingArtifact(value) {
  const text = String(value ?? '');
  return PROHIBITED_ENCODING_ARTIFACTS.some((pattern) => pattern.test(text));
}

function sanitizePublicResponseText(value, fallback = 'I can help with general information about KEYR, but I do not have sufficiently approved information for that question.') {
  const normalized = normalizePublicText(value);
  if (!normalized || hasProhibitedEncodingArtifact(normalized)) {
    const safeFallback = normalizePublicText(fallback);
    if (!safeFallback || hasProhibitedEncodingArtifact(safeFallback)) {
      return 'I can help with general information about KEYR, but I do not have sufficiently approved information for that question.';
    }
    return safeFallback;
  }
  return normalized;
}

function validateRequestBody(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Invalid JSON body.' };
  }

  const question = sanitizeText(body.question);
  if (!question) {
    return { valid: false, error: 'A question is required.' };
  }

  if (question.length > 2000) {
    return { valid: false, error: 'Question is too long.' };
  }

  if (body.honeypot && String(body.honeypot).trim() !== '') {
    return { valid: false, error: 'Invalid request.' };
  }

  const routeId = sanitizeText(body.currentPage || '');
  if (routeId && !ALLOWED_ROUTE_IDS.has(routeId)) {
    return { valid: false, error: 'Route is not allowed.' };
  }

  if (body.contactInput && typeof body.contactInput === 'object') {
    const contact = body.contactInput;
    const name = sanitizeText(contact.name || '');
    const email = normalizeEmail(contact.email || '');
    const phone = sanitizeText(contact.phone || '');
    const organization = sanitizeText(contact.organization || '');
    const topic = sanitizeText(contact.topic || '');
    const message = sanitizeText(contact.message || '');
    const consent = Boolean(contact.consent);

    if (name && name.length > 120) return { valid: false, error: 'Name is too long.' };
    if (email && !isValidEmail(email)) return { valid: false, error: 'Invalid email address.' };
    if (phone && phone.length > 50) return { valid: false, error: 'Phone number is too long.' };
    if (organization && organization.length > 200) return { valid: false, error: 'Organization is too long.' };
    if (message && message.length > 5000) return { valid: false, error: 'Message is too long.' };
    if (contact.consent === false && (contact.message || contact.email || contact.topic || contact.name)) {
      // consent is enforced later in flow; this is informational only
    }
    if (contact.consent !== undefined && typeof contact.consent !== 'boolean') {
      return { valid: false, error: 'Consent must be true or false.' };
    }
  }

  return { valid: true, question };
}

function validateModelResponse(rawResponse, allowedFacts = [], allowedRoutes = []) {
  if (!rawResponse || typeof rawResponse !== 'object') {
    return { valid: false, reason: 'invalid_json' };
  }

  const msg = sanitizeText(rawResponse.message || '');
  if (!msg) return { valid: false, reason: 'missing_message' };
  if (msg.length > 2000) return { valid: false, reason: 'message_too_long' };
  if (msg.includes('<') || msg.includes('>')) return { valid: false, reason: 'html_disallowed' };
  if (/https?:\/\//i.test(msg)) return { valid: false, reason: 'url_disallowed' };
  if (/\$\d|\d+%/.test(msg) && !/\d+\s*(?:%|\$)/.test(msg) && !/Today is/.test(msg)) {
    // accept only if not a forbidden numeric claim, but not a strong blocker for dates
  }

  const factsUsed = Array.isArray(rawResponse.factsUsed) ? rawResponse.factsUsed : [];
  const allowedFactSet = new Set((allowedFacts || []).filter(Boolean));
  const invalidFact = factsUsed.find((fact) => !allowedFactSet.has(fact));
  if (invalidFact) return { valid: false, reason: 'invalid_fact' };

  const actionRoutes = Array.isArray(rawResponse.actionRouteIds) ? rawResponse.actionRouteIds : [];
  const validRoutes = new Set((allowedRoutes || []).filter(Boolean));
  const invalidRoute = actionRoutes.find((route) => !validRoutes.has(route));
  if (invalidRoute) return { valid: false, reason: 'invalid_route' };

  const plainText = `${msg} ${JSON.stringify(factsUsed)} ${JSON.stringify(actionRoutes)}`;
  if (hasSensitivePattern(plainText)) {
    return { valid: false, reason: 'sensitive_pattern' };
  }

  const competitorName = sanitizeText(rawResponse.competitor || '');
  if (competitorName && !getCompetitorProfile(competitorName)) {
    return { valid: false, reason: 'unknown_competitor' };
  }

  return { valid: true };
}

function buildPrivacyMetadata() {
  return {
    sensitiveDataWarning: 'Please do not enter Social Security numbers, bank account numbers, card numbers, passwords, or other sensitive financial information.',
    privacyRouteId: 'privacy',
    termsRouteId: 'terms',
    securityRouteId: 'security'
  };
}

module.exports = {
  ALLOWED_TOPICS,
  sanitizeText,
  normalizePublicText,
  hasProhibitedEncodingArtifact,
  sanitizePublicResponseText,
  isValidEmail,
  hasSensitivePattern,
  validateRequestBody,
  validateModelResponse,
  buildPrivacyMetadata
};
