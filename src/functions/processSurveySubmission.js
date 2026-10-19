const { randomUUID } = require('crypto');
const { app } = require('@azure/functions');
const sql = require('mssql');
const {
  DEFAULT_SURVEY_VERSION,
  resolveSurveyVersion,
  validateV2026_10Responses
} = require('./surveySchema');

const QUEUE_NAME = 'keyr-survey-submissions';

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

function validateEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value || '').trim());
}

function isValidClientSubmissionId(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value.trim());
}

function parseQueueMessage(queueItem) {
  if (queueItem === null || queueItem === undefined) {
    throw Object.assign(new Error('Queue message is missing.'), { category: 'invalid_message' });
  }

  if (typeof queueItem === 'string') {
    try {
      return JSON.parse(queueItem);
    } catch (error) {
      throw Object.assign(new Error('Queue message is not valid JSON.'), { category: 'invalid_message' });
    }
  }

  if (typeof queueItem === 'object') {
    return queueItem;
  }

  throw Object.assign(new Error('Queue message must be a JSON object or string.'), { category: 'invalid_message' });
}

function classifyError(error) {
  const message = error && error.message ? error.message.toLowerCase() : '';
  const category = error && error.category ? error.category : null;

  if (category === 'invalid_message') return 'invalid_message';
  if (isUniqueKeyConflict(error)) {
    return 'duplicate_sql_key';
  }
  if (/timeout|econnreset|connection.*failed|temporarily unavailable|database.*paused|connection.*closed|cannot.*connect|server.*offline|login failed|network.*error/i.test(message)) {
    return 'transient_sql_connectivity';
  }
  if (/invalid column|does not exist|schema|column.*not found|object .* does not exist|type.*convert|conversion|not found/i.test(message) && !/rollback|transaction/i.test(message)) {
    return 'sql_schema_or_data';
  }
  if (/transaction|rollback|commit|begin/i.test(message)) {
    return 'transaction_failure';
  }
  return 'unexpected_failure';
}

function isUniqueKeyConflict(error) {
  if (!error) return false;
  const message = error && error.message ? error.message : String(error);
  const errorNumber = Number(error && error.number);
  return /cannot insert duplicate key|duplicate key|2601|2627/i.test(message) || [2601, 2627].includes(errorNumber);
}

function resolveQueueSurveyVersion(payload) {
  const resolved = resolveSurveyVersion(payload?.schema_version || payload?.survey_version);
  if (!resolved) {
    throw Object.assign(new Error('Queue message has an unsupported survey_version.'), { category: 'invalid_message' });
  }
  return resolved;
}

function buildSelectionRows(responses, surveyVersion = DEFAULT_SURVEY_VERSION) {
  if (surveyVersion === '2026.10') {
    const primaryOutcomes = Array.isArray(responses?.primary_outcomes) ? responses.primary_outcomes : [];
    return primaryOutcomes.map((option) => ({
      question_code: 'primary_outcomes',
      option_value: cleanString(option, 200)
    })).filter((row) => row.option_value);
  }

  const currentNeeds = Array.isArray(responses?.current_needs) ? responses.current_needs : [];
  return currentNeeds.map((option) => ({
    question_code: 'current_needs',
    option_value: cleanString(option, 200)
  })).filter((row) => row.option_value);
}

function getV2026_10NormalizedQueueResponses(responses) {
  const validated = validateV2026_10Responses({
    responses,
    cleanString,
    cleanArray,
    validateEmail
  });

  if (!validated.ok) {
    throw Object.assign(new Error('Queue message has invalid 2026.10 responses.'), { category: 'invalid_message' });
  }

  return validated.normalizedResponses;
}

let pool;

async function getPool() {
  if (pool && pool.connected) return pool;

  const connectionString = process.env.KEYR_DB_CONNECTION;
  if (!connectionString) {
    throw new Error('Missing KEYR_DB_CONNECTION application setting.');
  }

  pool = await sql.connect(connectionString);
  return pool;
}

async function resetPoolOnFailure() {
  if (pool) {
    try {
      await pool.close();
    } catch (closeError) {
      // no-op for stale connection cleanup
    }
  }
  pool = null;
}

function getProcessingDetails(context, clientSubmissionId, queuedAtUtc, startedAt) {
  return {
    client_submission_id: clientSubmissionId,
    dequeue_count: context?.bindingData?.dequeueCount ?? 0,
    queued_at_utc: queuedAtUtc || null,
    processing_started_at_utc: startedAt.toISOString(),
    processing_completed_at_utc: null,
    processing_duration_ms: 0,
    outcome: 'failed',
    error_category: null
  };
}

async function ensureNotDuplicate(pool, clientSubmissionId) {
  const query = `
    SELECT TOP 1 survey_submission_id
    FROM dbo.SurveySubmissions
    WHERE client_submission_id = @client_submission_id;
  `;

  const result = await new sql.Request(pool)
    .input('client_submission_id', sql.UniqueIdentifier, clientSubmissionId)
    .query(query);

  return result.recordset.length > 0 ? result.recordset[0].survey_submission_id : null;
}

async function processSurveySubmissionQueue({
  queueMessage,
  context,
  sqlLib = sql,
  getPoolFn = getPool,
  resetPoolFn = resetPoolOnFailure,
  ensureNotDuplicateFn = ensureNotDuplicate,
  buildSelectionRowsFn = buildSelectionRows,
  randomUUIDFn = randomUUID,
  transactionFactory = (pool) => new sqlLib.Transaction(pool),
  logger = console
}) {
  const startedAt = new Date();
  let payload;
  let clientSubmissionId = null;
  let resolvedSurveyVersion = null;
  let queuedAtUtc = null;
  let poolConnection = null;
  let transaction = null;
  const operation = getProcessingDetails(context, null, null, startedAt);

  try {
    payload = parseQueueMessage(queueMessage);
    const surveyVersion = resolveQueueSurveyVersion(payload);
    resolvedSurveyVersion = surveyVersion;
    clientSubmissionId = cleanString(payload?.client_submission_id, 64);
    queuedAtUtc = cleanString(payload?.queued_at_utc, 64) || null;
    operation.client_submission_id = clientSubmissionId;
    operation.queued_at_utc = queuedAtUtc;

    if (!isValidClientSubmissionId(clientSubmissionId)) {
      throw Object.assign(new Error('Queue message is missing a valid client_submission_id.'), { category: 'invalid_message' });
    }

    poolConnection = await getPoolFn();
    const existingSurveyId = await ensureNotDuplicateFn(poolConnection, clientSubmissionId);
    if (existingSurveyId) {
      operation.outcome = 'duplicate_skipped';
      operation.processing_completed_at_utc = new Date().toISOString();
      operation.processing_duration_ms = Date.now() - startedAt.getTime();
      if (context && typeof context.log === 'function') {
        context.log('Survey submission already processed; skipping duplicate queue item.', {
          client_submission_id: clientSubmissionId,
          survey_submission_id: existingSurveyId
        });
      }
      return {
        outcome: 'duplicate_skipped',
        client_submission_id: clientSubmissionId,
        survey_submission_id: existingSurveyId
      };
    }

    transaction = transactionFactory(poolConnection);
    await transaction.begin();

    const responses = payload.responses || {};
    const routing = payload.routing || {};
    const metadata = payload.metadata || {};
    const surveySubmissionId = payload.survey_submission_id || randomUUIDFn();
    const source = cleanString(payload.source, 50) || 'survey';
    const surveyName = cleanString(payload.survey_name, 100) || 'start_your_path';
    const title = cleanString(payload.title, 200) || 'Start Your Path';
    const pageUrl = cleanString(payload.page_url, 2048);
    const referrer = cleanString(payload.referrer, 2048);
    const userAgent = cleanString(metadata.user_agent || payload.user_agent, 1000);
    const language = cleanString(payload.language, 50);
    const timezone = cleanString(metadata.timezone || payload.timezone, 100);
    const submissionType = cleanString(metadata.submission_type, 20) || 'first';

    let journeyStage = cleanString(responses.journey_stage, 100);
    let currentNeedsJson = JSON.stringify(Array.isArray(responses.current_needs) ? responses.current_needs : []);
    let signupIntent = cleanString(responses.signup_intent, 100);
    let preferredStartingPath = cleanString(responses.preferred_starting_path, 100);
    let mostValuableBenefit = cleanString(responses.most_valuable_benefit, 100);
    let balanceTransferInterest = cleanString(responses.balance_transfer_interest, 100);
    let startingExperience = cleanString(responses.starting_experience, 120);
    let trustedApproach = cleanString(responses.trusted_approach, 120);
    let contactPermission = cleanString(responses.contact_permission, 50);

    let debtDuration = null;
    let cardSituation = null;
    let baselineApplyIntent90d = null;
    let approachChoice = null;
    let outcomeApplyIntent = null;
    let topConversionDriver = null;
    let feeAcceptance = null;
    let nextStep = null;
    let earlyAccessInterest = null;

    let email = cleanString(responses.email, 320);
    let openFeedback = cleanString(responses.open_feedback, 4000);
    let optedForContact = !!routing.opted_for_contact || contactPermission === 'yes_contact_me';

    if (surveyVersion === '2026.10') {
      const normalized = getV2026_10NormalizedQueueResponses(responses);

      journeyStage = null;
      currentNeedsJson = null;
      signupIntent = null;
      preferredStartingPath = null;
      mostValuableBenefit = null;
      balanceTransferInterest = null;
      startingExperience = null;
      trustedApproach = null;
      contactPermission = null;

      debtDuration = normalized.debt_duration;
      cardSituation = normalized.card_situation;
      baselineApplyIntent90d = normalized.baseline_apply_intent_90d;
      approachChoice = normalized.approach_choice;
      outcomeApplyIntent = normalized.outcome_apply_intent;
      topConversionDriver = normalized.top_conversion_driver;
      feeAcceptance = normalized.fee_acceptance;
      nextStep = normalized.next_step;
      earlyAccessInterest = normalized.early_access_interest;
      email = normalized.email;
      openFeedback = normalized.open_feedback;
      optedForContact = earlyAccessInterest === 'yes' || earlyAccessInterest === 'maybe';
    }

    const submittedAtUtc = cleanString(payload.submitted_at_utc || metadata.submitted_at_utc || new Date().toISOString(), 40);
    const rawPayload = JSON.stringify(payload);
    const selectionRows = buildSelectionRowsFn(responses, surveyVersion);

    const mainInsertSql = `
      INSERT INTO dbo.SurveySubmissions (
        survey_submission_id,
        client_submission_id,
        source,
        survey_name,
        title,
        page_url,
        referrer,
        user_agent,
        language,
        timezone,
        submission_type,
        debt_duration,
        card_situation,
        baseline_apply_intent_90d,
        approach_choice,
        outcome_apply_intent,
        top_conversion_driver,
        fee_acceptance,
        next_step,
        early_access_interest,
        journey_stage,
        current_needs_json,
        signup_intent,
        preferred_starting_path,
        most_valuable_benefit,
        balance_transfer_interest,
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
        payload_json,
        is_simulated,
        record_source,
        source_detail,
        survey_version,
        profile_builder_status
      )
      VALUES (
        @survey_submission_id,
        @client_submission_id,
        @source,
        @survey_name,
        @title,
        @page_url,
        @referrer,
        @user_agent,
        @language,
        @timezone,
        @submission_type,
        @debt_duration,
        @card_situation,
        @baseline_apply_intent_90d,
        @approach_choice,
        @outcome_apply_intent,
        @top_conversion_driver,
        @fee_acceptance,
        @next_step,
        @early_access_interest,
        @journey_stage,
        @current_needs_json,
        @signup_intent,
        @preferred_starting_path,
        @most_valuable_benefit,
        @balance_transfer_interest,
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
        @payload_json,
        @is_simulated,
        @record_source,
        @source_detail,
        @survey_version,
        @profile_builder_status
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

    const requestMain = new sqlLib.Request(transaction);
    requestMain.input('survey_submission_id', sqlLib.UniqueIdentifier, surveySubmissionId);
    requestMain.input('client_submission_id', sqlLib.UniqueIdentifier, clientSubmissionId);
    requestMain.input('source', sqlLib.NVarChar(50), source);
    requestMain.input('survey_name', sqlLib.NVarChar(100), surveyName);
    requestMain.input('title', sqlLib.NVarChar(200), title);
    requestMain.input('page_url', sqlLib.NVarChar(2048), pageUrl);
    requestMain.input('referrer', sqlLib.NVarChar(2048), referrer);
    requestMain.input('user_agent', sqlLib.NVarChar(1000), userAgent);
    requestMain.input('language', sqlLib.NVarChar(50), language);
    requestMain.input('timezone', sqlLib.NVarChar(100), timezone);
    requestMain.input('submission_type', sqlLib.NVarChar(20), submissionType);

    requestMain.input('debt_duration', sqlLib.NVarChar(100), debtDuration);
    requestMain.input('card_situation', sqlLib.NVarChar(100), cardSituation);
    requestMain.input('baseline_apply_intent_90d', sqlLib.NVarChar(100), baselineApplyIntent90d);
    requestMain.input('approach_choice', sqlLib.NVarChar(100), approachChoice);
    requestMain.input('outcome_apply_intent', sqlLib.NVarChar(100), outcomeApplyIntent);
    requestMain.input('top_conversion_driver', sqlLib.NVarChar(100), topConversionDriver);
    requestMain.input('fee_acceptance', sqlLib.NVarChar(100), feeAcceptance);
    requestMain.input('next_step', sqlLib.NVarChar(100), nextStep);
    requestMain.input('early_access_interest', sqlLib.NVarChar(100), earlyAccessInterest);

    requestMain.input('journey_stage', sqlLib.NVarChar(100), journeyStage);
    requestMain.input('current_needs_json', sqlLib.NVarChar(sqlLib.MAX), currentNeedsJson);
    requestMain.input('signup_intent', sqlLib.NVarChar(100), signupIntent);
    requestMain.input('preferred_starting_path', sqlLib.NVarChar(100), preferredStartingPath);
    requestMain.input('most_valuable_benefit', sqlLib.NVarChar(sqlLib.MAX), mostValuableBenefit);
    requestMain.input('balance_transfer_interest', sqlLib.NVarChar(sqlLib.MAX), balanceTransferInterest);
    requestMain.input('starting_experience', sqlLib.NVarChar(120), startingExperience);
    requestMain.input('learn_before_start_json', sqlLib.NVarChar(sqlLib.MAX), null);
    requestMain.input('trusted_approach', sqlLib.NVarChar(120), trustedApproach);
    requestMain.input('contact_permission', sqlLib.NVarChar(50), contactPermission);

    requestMain.input('email', sqlLib.NVarChar(320), email);
    requestMain.input('open_feedback', sqlLib.NVarChar(sqlLib.MAX), openFeedback);
    requestMain.input('education_interest', sqlLib.NVarChar(100), null);
    requestMain.input('wants_education', sqlLib.Bit, 0);
    requestMain.input('opted_for_contact', sqlLib.Bit, optedForContact ? 1 : 0);
    requestMain.input('submitted_at_utc', sqlLib.NVarChar(40), submittedAtUtc);
    requestMain.input('payload_json', sqlLib.NVarChar(sqlLib.MAX), rawPayload);
    requestMain.input('is_simulated', sqlLib.Bit, 0);
    requestMain.input('record_source', sqlLib.NVarChar(50), 'public_survey');
    requestMain.input('source_detail', sqlLib.NVarChar(100), 'keyr_public_website');
    requestMain.input('survey_version', sqlLib.NVarChar(30), surveyVersion);
    requestMain.input('profile_builder_status', sqlLib.NVarChar(30), 'offered');

    await requestMain.query(mainInsertSql);

    for (const row of selectionRows) {
      const requestSelection = new sqlLib.Request(transaction);
      requestSelection.input('survey_submission_id', sqlLib.UniqueIdentifier, surveySubmissionId);
      requestSelection.input('question_code', sqlLib.NVarChar(50), row.question_code);
      requestSelection.input('option_value', sqlLib.NVarChar(200), row.option_value);
      await requestSelection.query(selectionInsertSql);
    }

    await transaction.commit();
    operation.outcome = 'success';
    operation.processing_completed_at_utc = new Date().toISOString();
    operation.processing_duration_ms = Date.now() - startedAt.getTime();

    if (context && typeof context.log === 'function') {
      context.log('Survey queue submission processed successfully.', {
        client_submission_id: clientSubmissionId,
        survey_submission_id: surveySubmissionId,
        selection_count: selectionRows.length
      });
    }

    return {
      outcome: 'success',
      client_submission_id: clientSubmissionId,
      survey_submission_id: surveySubmissionId,
      selection_count: selectionRows.length
    };
  } catch (error) {
    operation.error_category = classifyError(error);
    operation.processing_completed_at_utc = new Date().toISOString();
    operation.processing_duration_ms = Date.now() - startedAt.getTime();

    if (transaction) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('Survey queue transaction rollback failed.', {
            client_submission_id: clientSubmissionId,
            rollback_error: rollbackError && rollbackError.message ? rollbackError.message : String(rollbackError)
          });
        }
        await resetPoolFn();
      }
    }

    if (context && typeof context.error === 'function') {
      context.error('Survey queue processing failed.', {
        client_submission_id: clientSubmissionId,
        dequeue_count: operation.dequeue_count,
        error_category: operation.error_category,
        queued_at_utc: queuedAtUtc,
        processing_started_at_utc: operation.processing_started_at_utc,
        processing_completed_at_utc: operation.processing_completed_at_utc,
        processing_duration_ms: operation.processing_duration_ms,
        outcome: operation.outcome
      });
    }

    if (operation.error_category === 'invalid_message') {
      if (context && typeof context.warn === 'function') {
        context.warn('Invalid survey queue message encountered; rethrowing for retry.', {
          client_submission_id: clientSubmissionId,
          resolved_survey_version: resolvedSurveyVersion,
          error_category: operation.error_category
        });
      }
      throw error;
    }

    if (operation.error_category === 'duplicate_sql_key' && clientSubmissionId && poolConnection) {
      try {
        const existingSurveyId = await ensureNotDuplicateFn(poolConnection, clientSubmissionId);
        if (existingSurveyId) {
          operation.outcome = 'duplicate_skipped';
          if (context && typeof context.log === 'function') {
            context.log('Duplicate SQL key resolved by existing survey record.', {
              client_submission_id: clientSubmissionId,
              survey_submission_id: existingSurveyId
            });
          }
          return {
            outcome: 'duplicate_skipped',
            client_submission_id: clientSubmissionId,
            survey_submission_id: existingSurveyId
          };
        }
      } catch (lookupError) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn('Unable to verify duplicate survey record after unique-key failure.', {
            client_submission_id: clientSubmissionId,
            lookup_error: lookupError && lookupError.message ? lookupError.message : String(lookupError)
          });
        }
      }
    }

    if (
      operation.error_category === 'transient_sql_connectivity' ||
      operation.error_category === 'transaction_failure' ||
      operation.error_category === 'duplicate_sql_key' ||
      operation.error_category === 'unexpected_failure'
    ) {
      await resetPoolFn();
    }

    throw error;
  }
}

app.storageQueue('processSurveySubmission', {
  queueName: QUEUE_NAME,
  connection: 'AzureWebJobsStorage',
  handler: async (queueMessage, context) => {
    return processSurveySubmissionQueue({ queueMessage, context });
  }
});

module.exports = {
  QUEUE_NAME,
  cleanString,
  cleanArray,
  parseQueueMessage,
  isUniqueKeyConflict,
  classifyError,
  isValidClientSubmissionId,
  resolveQueueSurveyVersion,
  buildSelectionRows,
  getV2026_10NormalizedQueueResponses,
  processSurveySubmissionQueue
};
