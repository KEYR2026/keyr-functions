const { app } = require('@azure/functions');
const sql = require('mssql');
const { randomUUID } = require('crypto');

let pool;

/**
 * Basic CORS support
 */
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

/**
 * Reuse SQL connection pool
 */
async function getPool() {
  if (pool && pool.connected) return pool;

  const connectionString = process.env.KEYR_DB_CONNECTION;

  if (!connectionString) {
    throw new Error('Missing KEYR_DB_CONNECTION application setting.');
  }

  pool = await sql.connect(connectionString);
  return pool;
}

/**
 * Clean and normalize strings
 */
function cleanString(value, maxLength = 4000) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

/**
 * Clean array values
 */
function cleanArray(value, maxLength = 200) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => cleanString(item, maxLength))
    .filter(Boolean);
}

/**
 * Loose boolean normalization
 */
function toBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
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

app.http('survey', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'survey',
  handler: async (request, context) => {
    const origin = request.headers.get('origin') || '';
    const headers = corsHeaders(origin);

    // Handle CORS preflight
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

    /**
     * Optional honeypot support
     * If you add a hidden field named "company" later on the frontend,
     * bots that fill it can be safely ignored.
     */
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

    // Core response fields
    const journeyStage = cleanString(responses.journey_stage, 100);
    const currentNeeds = cleanArray(responses.current_needs, 200);
    const interestStrength = cleanString(responses.interest_strength, 100);
    const startingExperience = cleanString(responses.starting_experience, 120);
    const learnBeforeStart = cleanArray(responses.learn_before_start, 200);
    const trustedApproach = cleanString(responses.trusted_approach, 120);
    const contactPermission = cleanString(responses.contact_permission, 50);
    const email = cleanString(responses.email, 320);
    const openFeedback = cleanString(responses.open_feedback, 4000);
    const educationInterest = cleanString(responses.education_interest, 50);

    // Metadata
    const submissionType = cleanString(metadata.submission_type, 20) || 'first';
    const pageUrl = cleanString(payload?.page_url, 2048);
    const referrer = cleanString(payload?.referrer, 2048);
    const userAgent = cleanString(metadata.user_agent || payload?.user_agent, 1000);
    const language = cleanString(payload?.language, 50);
    const timezone = cleanString(metadata.timezone || payload?.timezone, 100);
    const submittedAtUtc = cleanString(metadata.submitted_at_utc || payload?.submitted_at_utc, 40);

    const wantsEducation =
      toBool(routing.wants_education) ||
      educationInterest === 'yes_take_me_to_education';

    const optedForContact =
      toBool(routing.opted_for_contact) ||
      contactPermission === 'yes_contact_me';

    // Validation
    const validationErrors = [];

    if (source !== 'survey') validationErrors.push('source must equal "survey".');
    if (!journeyStage) validationErrors.push('journey_stage is required.');
    if (!currentNeeds.length) validationErrors.push('At least one current_needs option is required.');
    if (!interestStrength) validationErrors.push('interest_strength is required.');
    if (!startingExperience) validationErrors.push('starting_experience is required.');
    if (!learnBeforeStart.length) validationErrors.push('At least one learn_before_start option is required.');
    if (!trustedApproach) validationErrors.push('trusted_approach is required.');
    if (!contactPermission) validationErrors.push('contact_permission is required.');
    if (!educationInterest) validationErrors.push('education_interest is required.');

    if (optedForContact && !email) {
      validationErrors.push('email is required when contact_permission is yes_contact_me.');
    }

    if (validationErrors.length) {
      return badRequest(headers, 'Validation failed.', validationErrors);
    }

    const surveySubmissionId = randomUUID();
    const rawPayload = JSON.stringify(payload);
    const currentNeedsJson = JSON.stringify(currentNeeds);
    const learnBeforeStartJson = JSON.stringify(learnBeforeStart);

    const mainInsertSql = `
      INSERT INTO dbo.SurveySubmissions (
        survey_submission_id,
        source,
        survey_name,
        title,
        page_url,
        referrer,
        user_agent,
        language,
        timezone,
        submission_type,
        journey_stage,
        current_needs_json,
        interest_strength,
        starting_experience,
        learn_before_start_json,
        trusted_approach,
        contact_permission,
        email,
        open_feedback,
        education_interest,
        wants_education,
        opted_for_contact,
        submitted_at_utc,
        payload_json
      )
      VALUES (
        @survey_submission_id,
        @source,
        @survey_name,
        @title,
        @page_url,
        @referrer,
        @user_agent,
        @language,
        @timezone,
        @submission_type,
        @journey_stage,
        @current_needs_json,
        @interest_strength,
        @starting_experience,
        @learn_before_start_json,
        @trusted_approach,
        @contact_permission,
        @email,
        @open_feedback,
        @education_interest,
        @wants_education,
        @opted_for_contact,
        COALESCE(TRY_CAST(@submitted_at_utc AS datetime2(3)), SYSUTCDATETIME()),
        @payload_json
      );
    `;

    const selectionInsertSql = `
      INSERT INTO dbo.SurveySubmissionSelections (
        survey_submission_id,
        question_code,
        option_value
      )
      VALUES (
        @survey_submission_id,
        @question_code,
        @option_value
      );
    `;

    let transaction;

    try {
      const sqlPool = await getPool();
      transaction = new sql.Transaction(sqlPool);
      await transaction.begin();

      // Main row insert
      const requestMain = new sql.Request(transaction);
      requestMain.input('survey_submission_id', sql.UniqueIdentifier, surveySubmissionId);
      requestMain.input('source', sql.NVarChar(50), source);
      requestMain.input('survey_name', sql.NVarChar(100), surveyName);
      requestMain.input('title', sql.NVarChar(200), title);
      requestMain.input('page_url', sql.NVarChar(2048), pageUrl);
      requestMain.input('referrer', sql.NVarChar(2048), referrer);
      requestMain.input('user_agent', sql.NVarChar(1000), userAgent);
      requestMain.input('language', sql.NVarChar(50), language);
      requestMain.input('timezone', sql.NVarChar(100), timezone);
      requestMain.input('submission_type', sql.NVarChar(20), submissionType);
      requestMain.input('journey_stage', sql.NVarChar(100), journeyStage);
      requestMain.input('current_needs_json', sql.NVarChar(sql.MAX), currentNeedsJson);
      requestMain.input('interest_strength', sql.NVarChar(100), interestStrength);
      requestMain.input('starting_experience', sql.NVarChar(120), startingExperience);
      requestMain.input('learn_before_start_json', sql.NVarChar(sql.MAX), learnBeforeStartJson);
      requestMain.input('trusted_approach', sql.NVarChar(120), trustedApproach);
      requestMain.input('contact_permission', sql.NVarChar(50), contactPermission);
      requestMain.input('email', sql.NVarChar(320), email);
      requestMain.input('open_feedback', sql.NVarChar(sql.MAX), openFeedback);
      requestMain.input('education_interest', sql.NVarChar(50), educationInterest);
      requestMain.input('wants_education', sql.Bit, wantsEducation ? 1 : 0);
      requestMain.input('opted_for_contact', sql.Bit, optedForContact ? 1 : 0);
      requestMain.input('submitted_at_utc', sql.NVarChar(40), submittedAtUtc);
      requestMain.input('payload_json', sql.NVarChar(sql.MAX), rawPayload);

      await requestMain.query(mainInsertSql);

      // Child rows for multi-select answers
      const selectionRows = [
        ...currentNeeds.map(value => ({
          question_code: 'current_needs',
          option_value: value
        })),
        ...learnBeforeStart.map(value => ({
          question_code: 'learn_before_start',
          option_value: value
        }))
      ];

      for (const row of selectionRows) {
        const requestSelection = new sql.Request(transaction);
        requestSelection.input('survey_submission_id', sql.UniqueIdentifier, surveySubmissionId);
        requestSelection.input('question_code', sql.NVarChar(50), row.question_code);
        requestSelection.input('option_value', sql.NVarChar(200), row.option_value);
        await requestSelection.query(selectionInsertSql);
      }

      await transaction.commit();

      return {
        status: 200,
        headers,
        jsonBody: {
          ok: true,
          survey_submission_id: surveySubmissionId,
          submission_type: submissionType,
          wants_education: wantsEducation
        }
      };
    } catch (error) {
      context.error('Survey submission failed.', error);

      if (transaction) {
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          context.error('Survey transaction rollback failed.', rollbackError);
        }
      }

      return {
        status: 500,
        headers,
        jsonBody: {
          ok: false,
          error: 'Survey submission failed.'
        }
      };
    }
  }
});