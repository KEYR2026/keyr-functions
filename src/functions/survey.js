const { app } = require('@azure/functions');
const { QueueClient } = require('@azure/storage-queue');

const QUEUE_NAME = 'keyr-survey-submissions';
const SURVEY_SCHEMA_VERSION = '2026.09';

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

function buildQueueMessage(payload) {
  const clientSubmissionId = cleanString(payload?.client_submission_id, 64);
  const queuedAtUtc = new Date().toISOString();

  return {
    ...payload,
    source: 'survey',
    client_submission_id: clientSubmissionId,
    queued_at_utc: queuedAtUtc,
    schema_version: SURVEY_SCHEMA_VERSION,
    metadata: {
      ...(payload?.metadata || {}),
      submitted_at_utc: payload?.metadata?.submitted_at_utc || payload?.submitted_at_utc || queuedAtUtc,
      user_agent: cleanString(payload?.metadata?.user_agent || payload?.user_agent, 1000),
      timezone: cleanString(payload?.metadata?.timezone || payload?.timezone, 100)
    }
  };
}

async function enqueueSurveySubmission(context, payload, queueClientFactory = (connectionString, queueName) => new QueueClient(connectionString, queueName)) {
  const storageConnectionString = process.env.AzureWebJobsStorage;
  if (!storageConnectionString) {
    throw new Error('Missing AzureWebJobsStorage application setting.');
  }

  const queueMessage = buildQueueMessage(payload);
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

    const source = cleanString(payload?.source, 50);
    const surveyName = cleanString(payload?.survey_name, 100) || 'start_your_path';
    const title = cleanString(payload?.title, 200) || 'Start Your Path';
    const responses = payload?.responses || {};
    const routing = payload?.routing || {};
    const metadata = payload?.metadata || {};
    const clientSubmissionId = cleanString(payload?.client_submission_id, 64);

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

    if (source !== 'survey') validationErrors.push('source must equal "survey".');
    if (!clientSubmissionId || !isValidClientSubmissionId(clientSubmissionId)) {
      validationErrors.push('client_submission_id is required and must be a valid UUID.');
    }
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

    if (validationErrors.length) {
      return badRequest(headers, 'Validation failed.', validationErrors);
    }

    const normalizedPayload = {
      ...payload,
      source,
      survey_name: surveyName,
      title,
      client_submission_id: clientSubmissionId,
      submitted_at_utc: submittedAtUtc,
      page_url: pageUrl,
      referrer,
      user_agent: userAgent,
      language,
      timezone,
      responses: {
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
      },
      routing: {
        ...routing,
        opted_for_contact: optedForContact
      },
      metadata: {
        ...metadata,
        submission_type: submissionType,
        submitted_at_utc: submittedAtUtc,
        user_agent: userAgent,
        timezone,
        source: 'survey'
      }
    };

    try {
      await enqueueSurveySubmission(context, normalizedPayload);

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
  isValidClientSubmissionId
};