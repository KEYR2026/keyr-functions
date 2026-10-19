const { app } = require('@azure/functions');
const { QueueClient } = require('@azure/storage-queue');
const {
  DEFAULT_SURVEY_VERSION,
  resolveSurveyVersion,
  validateV2026_10Responses
} = require('./surveySchema');

const QUEUE_NAME = 'keyr-survey-submissions';
const SURVEY_SCHEMA_VERSION = DEFAULT_SURVEY_VERSION;

function cleanString(value, maxLength = 4000) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function cleanArray(value, maxLength = 200) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanString(item, maxLength))
    .filter(Boolean);
}

function toBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function validateEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value || '').trim());
}

function corsHeaders(origin) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  const resolvedOrigin = allowedOrigin === '*' ? '*' : (origin || allowedOrigin);

  return {
    'Access-Control-Allow-Origin': resolvedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json'
  };
}

function badRequest(headers, message, details = []) {
  return {
    status: 400,
    headers,
    jsonBody: {
      ok: false,
      error: message,
      details
    }
  };
}

function generateClientSubmissionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const randomValue = Math.random() * 16 | 0;
    const value = character === 'x' ? randomValue : (randomValue & 0x3 | 0x8);
    return value.toString(16);
  });
}

function isValidClientSubmissionId(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value.trim());
}

function buildQueueMessage(payload, resolvedVersion = null) {
  const clientSubmissionId = cleanString(payload?.client_submission_id, 64);
  const queuedAtUtc = new Date().toISOString();
  const schemaVersion = resolvedVersion || resolveSurveyVersion(payload?.survey_version) || DEFAULT_SURVEY_VERSION;

  return {
    ...payload,
    source: 'survey',
    survey_version: schemaVersion,
    client_submission_id: clientSubmissionId,
    queued_at_utc: queuedAtUtc,
    schema_version: schemaVersion,
    metadata: {
      ...(payload?.metadata || {}),
      submitted_at_utc: payload?.metadata?.submitted_at_utc || payload?.submitted_at_utc || queuedAtUtc,
      user_agent: cleanString(payload?.metadata?.user_agent || payload?.user_agent, 1000),
      timezone: cleanString(payload?.metadata?.timezone || payload?.timezone, 100)
    }
  };
}

function validateAndNormalizeSurveyPayload(payload) {
  const source = cleanString(payload?.source, 50);
  const resolvedSurveyVersion = resolveSurveyVersion(payload?.survey_version);
  if (!resolvedSurveyVersion) {
    return { ok: false, resolvedSurveyVersion: null, publicMessage: 'Invalid survey submission.', details: [] };
  }

  const surveyName = cleanString(payload?.survey_name, 100) || 'start_your_path';
  const title = cleanString(payload?.title, 200) || 'Start Your Path';
  const responses = payload?.responses || {};
  const routing = payload?.routing || {};
  const metadata = payload?.metadata || {};
  const clientSubmissionId = cleanString(payload?.client_submission_id, 64);

  const journeyStage = cleanString(responses.journey_stage, 100);
  const currentNeeds = cleanArray(responses.current_needs, 200);
  const startingExperience = cleanString(responses.starting_experience, 120);
  const trustedApproach = cleanString(responses.trusted_approach, 120);
  const contactPermission = cleanString(responses.contact_permission, 50);
  const email = cleanString(responses.email, 320);
  const openFeedback = cleanString(responses.open_feedback, 4000);
  const signupIntent = cleanString(responses.signup_intent, 100);
  const preferredStartingPath = cleanString(responses.preferred_starting_path, 100);
  const mostValuableBenefit = cleanString(responses.most_valuable_benefit, 100);
  const balanceTransferInterest = cleanString(responses.balance_transfer_interest, 100);

  const submissionType = cleanString(metadata.submission_type, 20) || 'first';
  const pageUrl = cleanString(payload?.page_url, 2048);
  const referrer = cleanString(payload?.referrer, 2048);
  const userAgent = cleanString(metadata.user_agent || payload?.user_agent, 1000);
  const language = cleanString(payload?.language, 50);
  const timezone = cleanString(metadata.timezone || payload?.timezone, 100);
  const submittedAtUtc = cleanString(metadata.submitted_at_utc || payload?.submitted_at_utc, 40);
  const optedForContact = toBool(routing.opted_for_contact) || contactPermission === 'yes_contact_me';

  const validationErrors = [];
  let normalizedV2026_10 = null;

  if (source !== 'survey') validationErrors.push('source must equal "survey".');
  if (!clientSubmissionId || !isValidClientSubmissionId(clientSubmissionId)) {
    validationErrors.push('client_submission_id is required and must be a valid UUID.');
  }

  if (resolvedSurveyVersion === '2026.09') {
    if (!journeyStage) validationErrors.push('journey_stage is required.');
    if (!currentNeeds.length) validationErrors.push('At least one current_needs option is required.');
    if (!signupIntent) validationErrors.push('signup_intent is required.');
    if (!startingExperience) validationErrors.push('starting_experience is required.');
    if (!mostValuableBenefit) validationErrors.push('At least one most_valuable_benefit option is required.');
    if (!trustedApproach) validationErrors.push('trusted_approach is required.');
    if (!contactPermission) validationErrors.push('contact_permission is required.');
    if (!balanceTransferInterest) validationErrors.push('balance_transfer_interest is required.');
    if (optedForContact && !email) {
      validationErrors.push('email is required when contact_permission is yes_contact_me.');
    }
  } else {
    const validatedV2026_10 = validateV2026_10Responses({
      responses,
      cleanString,
      cleanArray,
      validateEmail
    });

    normalizedV2026_10 = validatedV2026_10.normalizedResponses;
    if (!validatedV2026_10.ok) {
      validationErrors.push(...validatedV2026_10.validationErrors);
    }
  }

  if (validationErrors.length) {
    return {
      ok: false,
      resolvedSurveyVersion,
      publicMessage: 'Validation failed.',
      details: resolvedSurveyVersion === '2026.10' ? [] : validationErrors
    };
  }

  const normalizedResponses = resolvedSurveyVersion === '2026.10'
    ? {
        primary_outcomes: normalizedV2026_10.primary_outcomes,
        debt_duration: normalizedV2026_10.debt_duration,
        card_situation: normalizedV2026_10.card_situation,
        baseline_apply_intent_90d: normalizedV2026_10.baseline_apply_intent_90d,
        approach_choice: normalizedV2026_10.approach_choice,
        outcome_apply_intent: normalizedV2026_10.outcome_apply_intent,
        top_conversion_driver: normalizedV2026_10.top_conversion_driver,
        fee_acceptance: normalizedV2026_10.fee_acceptance,
        next_step: normalizedV2026_10.next_step,
        early_access_interest: normalizedV2026_10.early_access_interest,
        email: normalizedV2026_10.email,
        open_feedback: normalizedV2026_10.open_feedback
      }
    : {
        ...responses,
        starting_experience: startingExperience,
        current_needs: currentNeeds,
        journey_stage: journeyStage,
        signup_intent: signupIntent,
        preferred_starting_path: preferredStartingPath,
        most_valuable_benefit: mostValuableBenefit,
        balance_transfer_interest: balanceTransferInterest,
        trusted_approach: trustedApproach,
        contact_permission: contactPermission,
        email,
        open_feedback: openFeedback
      };

  const normalizedRouting = resolvedSurveyVersion === '2026.10'
    ? {
        ...routing,
        opted_for_contact: normalizedV2026_10.early_access_interest === 'yes' || normalizedV2026_10.early_access_interest === 'maybe'
      }
    : {
        ...routing,
        opted_for_contact: optedForContact
      };

  return {
    ok: true,
    resolvedSurveyVersion,
    normalizedPayload: {
      ...payload,
      source,
      survey_version: resolvedSurveyVersion,
      survey_name: surveyName,
      title,
      client_submission_id: clientSubmissionId,
      submitted_at_utc: submittedAtUtc,
      page_url: pageUrl,
      referrer,
      user_agent: userAgent,
      language,
      timezone,
      responses: normalizedResponses,
      routing: normalizedRouting,
      metadata: {
        ...metadata,
        submission_type: submissionType,
        submitted_at_utc: submittedAtUtc,
        user_agent: userAgent,
        timezone,
        source: 'survey'
      }
    }
  };
}

async function enqueueSurveySubmission(context, payload, queueClientFactory = (connectionString, queueName) => new QueueClient(connectionString, QUEUE_NAME), resolvedVersion = null) {
  const storageConnectionString = process.env.AzureWebJobsStorage;
  if (!storageConnectionString) {
    throw new Error('Missing AzureWebJobsStorage application setting.');
  }

  const queueMessage = buildQueueMessage(payload, resolvedVersion);
  const queueClient = queueClientFactory(storageConnectionString, QUEUE_NAME);
  await queueClient.sendMessage(JSON.stringify(queueMessage), {
    messageTimeToLive: 7 * 24 * 60 * 60
  });

  return queueMessage;
}

app.http('survey', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'survey',
  handler: async (request, context) => {
    const origin = request.headers.get('origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return {
        status: 204,
        headers
      };
    }

    let payload;
    try {
      payload = await request.json();
    } catch (error) {
      context.warn('Invalid JSON payload received.', error);
      return badRequest(headers, 'Invalid JSON payload.');
    }

    const validation = validateAndNormalizeSurveyPayload(payload);

    const honeypot = cleanString(payload?.company, 200);
    if (honeypot) {
      return {
        status: 200,
        headers,
        jsonBody: {
          ok: true,
          ignored: true
        }
      };
    }

    if (!validation.ok) {
      return badRequest(headers, validation.publicMessage, validation.details);
    }

    const normalizedPayload = validation.normalizedPayload;
    const resolvedSurveyVersion = validation.resolvedSurveyVersion;
    const clientSubmissionId = normalizedPayload.client_submission_id;

    try {
      await enqueueSurveySubmission(context, normalizedPayload, undefined, resolvedSurveyVersion);

      return {
        status: 202,
        headers,
        jsonBody: {
          ok: true,
          accepted: true,
          client_submission_id: clientSubmissionId
        }
      };
    } catch (error) {
      context.error('Survey queue acceptance failed.', error);
      return {
        status: 503,
        headers,
        jsonBody: {
          ok: false,
          accepted: false,
          error: 'We could not receive your survey right now. Please try again later.'
        }
      };
    }
  }
});

module.exports = {
  QUEUE_NAME,
  SURVEY_SCHEMA_VERSION,
  buildQueueMessage,
  cleanArray,
  cleanString,
  enqueueSurveySubmission,
  generateClientSubmissionId,
  isValidClientSubmissionId,
  validateEmail,
  validateAndNormalizeSurveyPayload
};
