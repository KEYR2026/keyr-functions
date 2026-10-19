const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  generateClientSubmissionId,
  isValidClientSubmissionId,
  buildQueueMessage,
  enqueueSurveySubmission,
  validateAndNormalizeSurveyPayload
} = require('../src/functions/survey.js');

const {
  parseQueueMessage,
  isValidClientSubmissionId: isValidQueueClientId,
  buildSelectionRows,
  resolveQueueSurveyVersion,
  classifyError,
  isUniqueKeyConflict,
  processSurveySubmissionQueue
} = require('../src/functions/processSurveySubmission.js');

const {
  resolveSurveyVersion
} = require('../src/functions/surveySchema.js');

function makeBaseTopLevelPayload() {
  return {
    source: 'survey',
    client_submission_id: '12121212-1212-4121-8121-121212121212',
    survey_name: 'start_your_path',
    title: 'Start Your Path',
    submitted_at_utc: '2026-10-18T10:00:00.000Z',
    page_url: 'http://localhost/survey.html',
    referrer: '',
    user_agent: 'node-test',
    language: 'en-US',
    timezone: 'America/Chicago',
    metadata: {
      submission_type: 'first',
      submitted_at_utc: '2026-10-18T10:00:00.000Z',
      user_agent: 'node-test',
      timezone: 'America/Chicago'
    },
    routing: {},
    tags: { app: 'KEYR', experience: 'path_survey', channel: 'web' },
    company: ''
  };
}

function makeV2026_10Payload(overrides = {}) {
  const payload = {
    ...makeBaseTopLevelPayload(),
    survey_version: '2026.10',
    responses: {
      primary_outcomes: ['reduce_high_interest_debt', 'debt_free_sooner'],
      debt_duration: 'over_1_year',
      card_situation: 'multiple_balances',
      baseline_apply_intent_90d: 'probably',
      approach_choice: 'keyr_financial_progress',
      outcome_apply_intent: 'very_likely',
      top_conversion_driver: 'interest_savings',
      fee_acceptance: 'depends_on_net_savings',
      next_step: 'review_terms_then_consider',
      early_access_interest: 'yes',
      email: 'user@example.com',
      open_feedback: 'Helpful tools and lower interest.'
    },
    routing: {
      opted_for_contact: true
    }
  };

  return {
    ...payload,
    ...overrides,
    responses: {
      ...payload.responses,
      ...(overrides.responses || {})
    },
    routing: {
      ...payload.routing,
      ...(overrides.routing || {})
    },
    metadata: {
      ...payload.metadata,
      ...(overrides.metadata || {})
    }
  };
}

function makeV2026_09Payload(overrides = {}) {
  const payload = {
    ...makeBaseTopLevelPayload(),
    survey_version: '2026.09',
    responses: {
      journey_stage: 'want_to_improve_and_grow',
      current_needs: ['reduce_interest_costs', 'lower_monthly_payments'],
      signup_intent: 'probably_would',
      preferred_starting_path: 'lower_interest_unsecured_if_eligible',
      starting_experience: 'lower_interest_unsecured_if_eligible',
      most_valuable_benefit: 'lower_interest_costs',
      balance_transfer_interest: 'very_interested',
      trusted_approach: 'structured_progress_over_time',
      contact_permission: 'no_just_feedback',
      email: null,
      open_feedback: 'existing flow'
    },
    routing: {
      opted_for_contact: false
    }
  };

  return {
    ...payload,
    ...overrides,
    responses: {
      ...payload.responses,
      ...(overrides.responses || {})
    },
    routing: {
      ...payload.routing,
      ...(overrides.routing || {})
    },
    metadata: {
      ...payload.metadata,
      ...(overrides.metadata || {})
    }
  };
}

function createContext() {
  return {
    bindingData: { dequeueCount: 2 },
    log: () => {},
    warn: () => {},
    error: () => {}
  };
}

test('survey intake creates a valid client_submission_id', () => {
  const value = generateClientSubmissionId();
  assert.equal(isValidClientSubmissionId(value), true);
});

test('host.json contains required queue runtime configuration', () => {
  const hostConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'host.json'), 'utf8'));
  const queueConfig = hostConfig.extensions.queues;

  assert.equal(queueConfig.messageEncoding, 'none');
  assert.equal(queueConfig.visibilityTimeout, '00:01:00');
  assert.equal(queueConfig.maxDequeueCount, 10);
  assert.equal(queueConfig.batchSize, 8);
  assert.equal(queueConfig.newBatchThreshold, 4);
  assert.equal(queueConfig.maxPollingInterval, '00:00:05');
});

test('survey queue intake calls QueueClient.sendMessage with JSON, TTL, and preserved client id', async () => {
  const originalConnection = process.env.AzureWebJobsStorage;
  process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';

  const localSendCalls = [];
  const localQueueClient = {
    sendMessage: async (payload, options) => {
      localSendCalls.push({ payload, options });
    }
  };

  const queueClientFactory = (connectionString, queueName) => {
    assert.equal(connectionString, 'UseDevelopmentStorage=true');
    assert.equal(queueName, 'keyr-survey-submissions');
    return localQueueClient;
  };

  const payload = {
    source: 'survey',
    client_submission_id: '11111111-1111-4111-8111-111111111111',
    responses: {
      journey_stage: 'just_exploring',
      current_needs: ['debt_reduction']
    },
    metadata: {
      submitted_at_utc: '2026-10-16T00:00:00.000Z'
    }
  };

  try {
    const message = await enqueueSurveySubmission(createContext(), payload, queueClientFactory);
    assert.equal(localSendCalls.length, 1);
    assert.equal(typeof localSendCalls[0].payload, 'string');
    assert.deepEqual(JSON.parse(localSendCalls[0].payload), message);
    assert.equal(localSendCalls[0].options.messageTimeToLive, 604800);
    assert.equal(JSON.parse(localSendCalls[0].payload).client_submission_id, payload.client_submission_id);
  } finally {
    if (originalConnection === undefined) {
      delete process.env.AzureWebJobsStorage;
    } else {
      process.env.AzureWebJobsStorage = originalConnection;
    }
  }
});

test('buildQueueMessage creates only one source property and source equals survey', () => {
  const payload = {
    source: 'survey',
    client_submission_id: '22222222-2222-4222-8222-222222222222',
    metadata: { submitted_at_utc: '2026-10-16T00:00:00.000Z' }
  };

  const message = buildQueueMessage(payload);
  assert.equal(message.source, 'survey');
  assert.equal(Object.keys(message).filter((key) => key === 'source').length, 1);
});

test('valid v2026.10 payload validates and enqueues schema_version 2026.10', async () => {
  const originalConnection = process.env.AzureWebJobsStorage;
  process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';

  const payload = makeV2026_10Payload();
  const validation = validateAndNormalizeSurveyPayload(payload);
  assert.equal(validation.ok, true);
  assert.equal(validation.resolvedSurveyVersion, '2026.10');

  const calls = [];
  try {
    await enqueueSurveySubmission(
      createContext(),
      validation.normalizedPayload,
      () => ({
        sendMessage: async (message) => calls.push(JSON.parse(message))
      }),
      validation.resolvedSurveyVersion
    );
  } finally {
    if (originalConnection === undefined) {
      delete process.env.AzureWebJobsStorage;
    } else {
      process.env.AzureWebJobsStorage = originalConnection;
    }
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].schema_version, '2026.10');
  assert.equal(calls[0].survey_version, '2026.10');
});

test('missing survey_version resolves to 2026.09', () => {
  assert.equal(resolveSurveyVersion(undefined), '2026.09');
  const payload = makeV2026_09Payload({ survey_version: undefined });
  const validation = validateAndNormalizeSurveyPayload(payload);
  assert.equal(validation.ok, true);
  assert.equal(validation.resolvedSurveyVersion, '2026.09');
});

test('unknown survey_version is rejected with 400-compatible validation failure', () => {
  const payload = makeV2026_10Payload({ survey_version: '2027.01' });
  const validation = validateAndNormalizeSurveyPayload(payload);
  assert.equal(validation.ok, false);
  assert.equal(validation.publicMessage, 'Invalid survey submission.');
  assert.equal(resolveSurveyVersion('2027.01'), null);
});

test('v2026.10 missing required field is rejected', () => {
  const payload = makeV2026_10Payload({ responses: { debt_duration: null } });
  const validation = validateAndNormalizeSurveyPayload(payload);
  assert.equal(validation.ok, false);
  assert.equal(validation.publicMessage, 'Validation failed.');
});

test('v2026.10 invalid option is rejected', () => {
  const payload = makeV2026_10Payload({ responses: { card_situation: 'bad_value' } });
  const validation = validateAndNormalizeSurveyPayload(payload);
  assert.equal(validation.ok, false);
  assert.equal(validation.publicMessage, 'Validation failed.');
});

test('v2026.10 primary_outcomes enforces 1-2 unique values', () => {
  const zero = validateAndNormalizeSurveyPayload(makeV2026_10Payload({ responses: { primary_outcomes: [] } }));
  const three = validateAndNormalizeSurveyPayload(makeV2026_10Payload({ responses: { primary_outcomes: ['reduce_high_interest_debt', 'debt_free_sooner', 'lower_monthly_payments'] } }));
  const dup = validateAndNormalizeSurveyPayload(makeV2026_10Payload({ responses: { primary_outcomes: ['reduce_high_interest_debt', 'reduce_high_interest_debt'] } }));

  assert.equal(zero.ok, false);
  assert.equal(three.ok, false);
  assert.equal(dup.ok, false);
});

test('v2026.10 early_access_interest yes/maybe requires valid email', () => {
  const yesMissing = validateAndNormalizeSurveyPayload(makeV2026_10Payload({ responses: { early_access_interest: 'yes', email: null } }));
  const maybeInvalid = validateAndNormalizeSurveyPayload(makeV2026_10Payload({ responses: { early_access_interest: 'maybe', email: 'bad-email' } }));

  assert.equal(yesMissing.ok, false);
  assert.equal(maybeInvalid.ok, false);
});

test('v2026.10 early_access_interest no accepts and clears email', () => {
  const validation = validateAndNormalizeSurveyPayload(makeV2026_10Payload({
    responses: { early_access_interest: 'no', email: 'should_be_discarded@example.com' },
    routing: { opted_for_contact: true }
  }));

  assert.equal(validation.ok, true);
  assert.equal(validation.normalizedPayload.responses.email, null);
  assert.equal(validation.normalizedPayload.routing.opted_for_contact, false);
});

test('v2026.10 open_feedback longer than 1000 is truncated', () => {
  const longText = 'x'.repeat(1205);
  const validation = validateAndNormalizeSurveyPayload(makeV2026_10Payload({ responses: { open_feedback: longText } }));

  assert.equal(validation.ok, true);
  assert.equal(validation.normalizedPayload.responses.open_feedback.length, 1000);
});

test('processor v2026.10 maps new fields and selection rows correctly', async () => {
  const captured = { inputs: [] };
  const sqlLib = {
    MAX: 2147483647,
    UniqueIdentifier: 'uniqueidentifier',
    NVarChar: () => 'nvarchar',
    Bit: 'bit',
    Request: function Request() {
      return {
        input(name, type, value) {
          captured.inputs.push({ name, value });
        },
        async query() {}
      };
    },
    Transaction: function Transaction() {
      return {
        async begin() {},
        async rollback() {},
        async commit() {}
      };
    }
  };

  const result = await processSurveySubmissionQueue({
    queueMessage: {
      ...makeV2026_10Payload(),
      schema_version: '2026.10',
      queued_at_utc: '2026-10-18T10:00:00.000Z'
    },
    context: createContext(),
    sqlLib,
    getPoolFn: async () => ({ connected: true }),
    ensureNotDuplicateFn: async () => null,
    resetPoolFn: async () => {},
    randomUUIDFn: () => '11111111-2222-4333-8444-555555555555'
  });

  const inputByName = Object.fromEntries(captured.inputs.map((entry) => [entry.name, entry.value]));
  assert.equal(result.outcome, 'success');
  assert.equal(inputByName.survey_version, '2026.10');
  assert.equal(inputByName.debt_duration, 'over_1_year');
  assert.equal(inputByName.card_situation, 'multiple_balances');
  assert.equal(inputByName.baseline_apply_intent_90d, 'probably');
  assert.equal(inputByName.approach_choice, 'keyr_financial_progress');
  assert.equal(inputByName.outcome_apply_intent, 'very_likely');
  assert.equal(inputByName.top_conversion_driver, 'interest_savings');
  assert.equal(inputByName.fee_acceptance, 'depends_on_net_savings');
  assert.equal(inputByName.next_step, 'review_terms_then_consider');
  assert.equal(inputByName.early_access_interest, 'yes');
  assert.equal(inputByName.journey_stage, null);
  assert.equal(inputByName.current_needs_json, null);
  assert.equal(inputByName.starting_experience, null);
  assert.equal(inputByName.trusted_approach, null);
  assert.equal(inputByName.contact_permission, null);
  assert.equal(inputByName.opted_for_contact, 1);

  const selectionRows = buildSelectionRows(makeV2026_10Payload().responses, '2026.10');
  assert.deepEqual(selectionRows.map((row) => row.question_code), ['primary_outcomes', 'primary_outcomes']);
});

test('processor v2026.09 remains unchanged and uses legacy selection shape', async () => {
  const resolved = resolveQueueSurveyVersion({ schema_version: '2026.09' });
  assert.equal(resolved, '2026.09');

  const rows = buildSelectionRows(makeV2026_09Payload().responses, '2026.09');
  assert.deepEqual(rows, [
    { question_code: 'current_needs', option_value: 'reduce_interest_costs' },
    { question_code: 'current_needs', option_value: 'lower_monthly_payments' }
  ]);
});

test('v2026.10 duplicate client_submission_id returns duplicate_skipped', async () => {
  const result = await processSurveySubmissionQueue({
    queueMessage: {
      ...makeV2026_10Payload(),
      schema_version: '2026.10'
    },
    context: createContext(),
    getPoolFn: async () => ({ connected: true }),
    ensureNotDuplicateFn: async () => 'existing-id',
    resetPoolFn: async () => {}
  });

  assert.equal(result.outcome, 'duplicate_skipped');
});

test('v2026.10 rollback occurs when a selection insert fails', async () => {
  let rollbackCalled = false;
  let queryCount = 0;

  const sqlLib = {
    MAX: 2147483647,
    UniqueIdentifier: 'uniqueidentifier',
    NVarChar: () => 'nvarchar',
    Bit: 'bit',
    Request: function Request() {
      return {
        input() {},
        async query() {
          queryCount += 1;
          if (queryCount === 2) {
            throw new Error('selection insert failed');
          }
        }
      };
    },
    Transaction: function Transaction() {
      return {
        async begin() {},
        async rollback() { rollbackCalled = true; },
        async commit() {}
      };
    }
  };

  await assert.rejects(
    () => processSurveySubmissionQueue({
      queueMessage: {
        ...makeV2026_10Payload(),
        schema_version: '2026.10'
      },
      context: createContext(),
      sqlLib,
      getPoolFn: async () => ({ connected: true }),
      ensureNotDuplicateFn: async () => null,
      resetPoolFn: async () => {}
    }),
    /selection insert failed/
  );

  assert.equal(rollbackCalled, true);
});

test('queue parser accepts object and string payloads', () => {
  const objectMessage = { client_submission_id: '22222222-2222-4222-8222-222222222222' };
  const stringMessage = JSON.stringify(objectMessage);

  assert.deepEqual(parseQueueMessage(objectMessage), objectMessage);
  assert.deepEqual(parseQueueMessage(stringMessage), objectMessage);
  assert.equal(isValidQueueClientId(objectMessage.client_submission_id), true);
});

test('selection rows are created only for valid current_needs entries', () => {
  const rows = buildSelectionRows({ current_needs: ['debt_reduction', 'education', null] });
  assert.deepEqual(rows, [
    { question_code: 'current_needs', option_value: 'debt_reduction' },
    { question_code: 'current_needs', option_value: 'education' }
  ]);
});

test('SQL Server error number 2601 is recognized as a unique-key conflict', () => {
  const error = Object.assign(new Error('Violation of UNIQUE KEY constraint ... 2601'), { number: 2601 });
  assert.equal(isUniqueKeyConflict(error), true);
  assert.equal(classifyError(error), 'duplicate_sql_key');
});

test('SQL Server error number 2627 is recognized as a unique-key conflict', () => {
  const error = Object.assign(new Error('Violation of UNIQUE KEY constraint ... 2627'), { number: 2627 });
  assert.equal(isUniqueKeyConflict(error), true);
  assert.equal(classifyError(error), 'duplicate_sql_key');
});

test('confirmed unique-key conflict retries duplicate lookup, rolls back, and returns duplicate_skipped', async () => {
  let duplicateLookupCount = 0;
  let rollbackCalled = false;
  let beginCalled = false;
  let commitCalled = false;

  const sqlLib = {
    MAX: 2147483647,
    UniqueIdentifier: 'uniqueidentifier',
    NVarChar: () => 'nvarchar',
    Bit: 'bit',
    Request: function Request() {
      return {
        input(name, type, value) {
          this[name] = value;
        },
        async query() {
          throw Object.assign(new Error('Violation of UNIQUE KEY constraint ... 2601'), { number: 2601 });
        }
      };
    },
    Transaction: function Transaction() {
      return {
        async begin() { beginCalled = true; },
        async rollback() { rollbackCalled = true; },
        async commit() { commitCalled = true; }
      };
    }
  };

  const context = createContext();
  const queueMessage = {
    client_submission_id: '33333333-3333-4333-8333-333333333333',
    queued_at_utc: '2026-10-17T00:00:00.000Z',
    responses: { journey_stage: 'just_exploring', current_needs: ['debt_reduction'] },
    routing: { opted_for_contact: false },
    metadata: { submitted_at_utc: '2026-10-17T00:00:00.000Z' },
    source: 'survey',
    survey_name: 'start_your_path',
    title: 'Start Your Path'
  };

  const result = await processSurveySubmissionQueue({
    queueMessage,
    context,
    sqlLib,
    getPoolFn: async () => ({ connected: true }),
    ensureNotDuplicateFn: async () => {
      duplicateLookupCount += 1;
      return duplicateLookupCount === 2 ? 'existing-survey-id' : null;
    },
    resetPoolFn: async () => {},
    buildSelectionRowsFn: (responses) => [{ question_code: 'current_needs', option_value: 'debt_reduction' }],
    randomUUIDFn: () => 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  });

  assert.equal(result.outcome, 'duplicate_skipped');
  assert.equal(rollbackCalled, true);
  assert.equal(beginCalled, true);
  assert.equal(commitCalled, false);
  assert.equal(result.survey_submission_id, 'existing-survey-id');
});

test('unconfirmed unique-key conflict rolls back, finds no row, and rethrows original error', async () => {
  let rollbackCalled = false;
  let duplicateLookupCount = 0;

  const sqlLib = {
    MAX: 2147483647,
    UniqueIdentifier: 'uniqueidentifier',
    NVarChar: () => 'nvarchar',
    Bit: 'bit',
    Request: function Request() {
      return {
        input() {},
        async query() {
          throw Object.assign(new Error('Violation of UNIQUE KEY constraint ... 2601'), { number: 2601 });
        }
      };
    },
    Transaction: function Transaction() {
      return {
        async begin() {},
        async rollback() { rollbackCalled = true; },
        async commit() {}
      };
    }
  };

  const queueMessage = {
    client_submission_id: '44444444-4444-4444-8444-444444444444',
    queued_at_utc: '2026-10-17T00:00:00.000Z',
    responses: { journey_stage: 'just_exploring', current_needs: ['debt_reduction'] },
    routing: { opted_for_contact: false },
    metadata: { submitted_at_utc: '2026-10-17T00:00:00.000Z' },
    source: 'survey',
    survey_name: 'start_your_path',
    title: 'Start Your Path'
  };

  await assert.rejects(
    () => processSurveySubmissionQueue({
      queueMessage,
      context: createContext(),
      sqlLib,
      getPoolFn: async () => ({ connected: true }),
      ensureNotDuplicateFn: async () => {
        duplicateLookupCount += 1;
        return duplicateLookupCount === 1 ? null : null;
      },
      resetPoolFn: async () => {},
      buildSelectionRowsFn: () => [{ question_code: 'current_needs', option_value: 'debt_reduction' }],
      randomUUIDFn: () => 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
    }),
    /Violation of UNIQUE KEY constraint/
  );

  assert.equal(rollbackCalled, true);
});

test('child selection insert failure rolls back and rethrows without commit', async () => {
  let rollbackCalled = false;
  let commitCalled = false;
  let requestCallCount = 0;

  const sqlLib = {
    MAX: 2147483647,
    UniqueIdentifier: 'uniqueidentifier',
    NVarChar: () => 'nvarchar',
    Bit: 'bit',
    Request: function Request() {
      return {
        input() {},
        async query() {
          requestCallCount += 1;
          if (requestCallCount === 2) {
            throw new Error('Child selection insert failed');
          }
        }
      };
    },
    Transaction: function Transaction() {
      return {
        async begin() {},
        async rollback() { rollbackCalled = true; },
        async commit() { commitCalled = true; }
      };
    }
  };

  await assert.rejects(
    () => processSurveySubmissionQueue({
      queueMessage: {
        client_submission_id: '55555555-5555-4555-8555-555555555555',
        queued_at_utc: '2026-10-17T00:00:00.000Z',
        responses: { journey_stage: 'just_exploring', current_needs: ['debt_reduction'] },
        routing: { opted_for_contact: false },
        metadata: { submitted_at_utc: '2026-10-17T00:00:00.000Z' },
        source: 'survey',
        survey_name: 'start_your_path',
        title: 'Start Your Path'
      },
      context: createContext(),
      sqlLib,
      getPoolFn: async () => ({ connected: true }),
      ensureNotDuplicateFn: async () => null,
      resetPoolFn: async () => {},
      buildSelectionRowsFn: () => [{ question_code: 'current_needs', option_value: 'debt_reduction' }],
      randomUUIDFn: () => 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
    }),
    /Child selection insert failed/
  );

  assert.equal(rollbackCalled, true);
  assert.equal(commitCalled, false);
});

test('rollback failure logs safely, resets pool, and rethrows original processing error', async () => {
  let resetCount = 0;
  let warnCount = 0;

  const sqlLib = {
    MAX: 2147483647,
    UniqueIdentifier: 'uniqueidentifier',
    NVarChar: () => 'nvarchar',
    Bit: 'bit',
    Request: function Request() {
      return {
        input() {},
        async query() {
          throw Object.assign(new Error('Violation of UNIQUE KEY constraint ... 2601'), { number: 2601 });
        }
      };
    },
    Transaction: function Transaction() {
      return {
        async begin() {},
        async rollback() { throw new Error('Rollback exploded'); },
        async commit() {}
      };
    }
  };

  const context = {
    bindingData: { dequeueCount: 1 },
    log: () => {},
    warn: () => { warnCount += 1; },
    error: () => {}
  };

  await assert.rejects(
    () => processSurveySubmissionQueue({
      queueMessage: {
        client_submission_id: '66666666-6666-4666-8666-666666666666',
        queued_at_utc: '2026-10-17T00:00:00.000Z',
        responses: { journey_stage: 'just_exploring', current_needs: ['debt_reduction'] },
        routing: { opted_for_contact: false },
        metadata: { submitted_at_utc: '2026-10-17T00:00:00.000Z' },
        source: 'survey',
        survey_name: 'start_your_path',
        title: 'Start Your Path'
      },
      context,
      sqlLib,
      getPoolFn: async () => ({ connected: true }),
      ensureNotDuplicateFn: async () => null,
      resetPoolFn: async () => { resetCount += 1; },
      logger: { warn: () => { warnCount += 1; } },
      buildSelectionRowsFn: () => [{ question_code: 'current_needs', option_value: 'debt_reduction' }],
      randomUUIDFn: () => 'dddddddd-dddd-4ddd-dddd-dddddddddddd'
    }),
    /Violation of UNIQUE KEY constraint/
  );

  assert.equal(warnCount > 0, true);
  assert.equal(resetCount >= 1, true);
});

test('transient SQL connectivity failure resets the cached pool and rethrows for queue redelivery', async () => {
  let resetCount = 0;

  const sqlLib = {
    MAX: 2147483647,
    UniqueIdentifier: 'uniqueidentifier',
    NVarChar: () => 'nvarchar',
    Bit: 'bit',
    Request: function Request() {
      return {
        input() {},
        async query() {
          throw new Error('Timeout: connect timed out to SQL server');
        }
      };
    },
    Transaction: function Transaction() {
      return {
        async begin() {},
        async rollback() {},
        async commit() {}
      };
    }
  };

  await assert.rejects(
    () => processSurveySubmissionQueue({
      queueMessage: {
        client_submission_id: '77777777-7777-4777-8777-777777777777',
        queued_at_utc: '2026-10-17T00:00:00.000Z',
        responses: { journey_stage: 'just_exploring', current_needs: ['debt_reduction'] },
        routing: { opted_for_contact: false },
        metadata: { submitted_at_utc: '2026-10-17T00:00:00.000Z' },
        source: 'survey',
        survey_name: 'start_your_path',
        title: 'Start Your Path'
      },
      context: createContext(),
      sqlLib,
      getPoolFn: async () => ({ connected: true }),
      ensureNotDuplicateFn: async () => null,
      resetPoolFn: async () => { resetCount += 1; },
      buildSelectionRowsFn: () => [{ question_code: 'current_needs', option_value: 'debt_reduction' }],
      randomUUIDFn: () => 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee'
    }),
    /Timeout: connect timed out/
  );

  assert.equal(resetCount, 1);
});

test('normal nonduplicate processing error is rethrown for retry or poison-queue handling', async () => {
  const sqlLib = {
    MAX: 2147483647,
    UniqueIdentifier: 'uniqueidentifier',
    NVarChar: () => 'nvarchar',
    Bit: 'bit',
    Request: function Request() {
      return {
        input() {},
        async query() {
          throw new Error('unexpected validation failure');
        }
      };
    },
    Transaction: function Transaction() {
      return {
        async begin() {},
        async rollback() {},
        async commit() {}
      };
    }
  };

  await assert.rejects(
    () => processSurveySubmissionQueue({
      queueMessage: {
        client_submission_id: '88888888-8888-4888-8888-888888888888',
        queued_at_utc: '2026-10-17T00:00:00.000Z',
        responses: { journey_stage: 'just_exploring', current_needs: ['debt_reduction'] },
        routing: { opted_for_contact: false },
        metadata: { submitted_at_utc: '2026-10-17T00:00:00.000Z' },
        source: 'survey',
        survey_name: 'start_your_path',
        title: 'Start Your Path'
      },
      context: createContext(),
      sqlLib,
      getPoolFn: async () => ({ connected: true }),
      ensureNotDuplicateFn: async () => null,
      resetPoolFn: async () => {},
      buildSelectionRowsFn: () => [{ question_code: 'current_needs', option_value: 'debt_reduction' }],
      randomUUIDFn: () => 'ffffffff-ffff-4fff-ffff-ffffffffffff'
    }),
    /unexpected validation failure/
  );
});

test('invalid queue message warns with safe metadata and rethrows for retry', async () => {
  const warns = [];
  const sqlLib = {
    MAX: 2147483647,
    UniqueIdentifier: 'uniqueidentifier',
    NVarChar: () => 'nvarchar',
    Bit: 'bit',
    Request: function Request() {
      return {
        input() {},
        async query() {}
      };
    },
    Transaction: function Transaction() {
      return {
        async begin() {},
        async rollback() {},
        async commit() {}
      };
    }
  };

  const context = {
    bindingData: { dequeueCount: 1 },
    log: () => {},
    warn: (message, details) => warns.push({ message, details }),
    error: () => {}
  };

  await assert.rejects(
    () => processSurveySubmissionQueue({
      queueMessage: {
        client_submission_id: 'abababab-abab-4bab-8bab-abababababab',
        schema_version: '2026.10',
        queued_at_utc: '2026-10-17T00:00:00.000Z',
        responses: {
          primary_outcomes: [],
          debt_duration: 'over_1_year',
          card_situation: 'multiple_balances',
          baseline_apply_intent_90d: 'probably',
          approach_choice: 'keyr_financial_progress',
          outcome_apply_intent: 'very_likely',
          top_conversion_driver: 'interest_savings',
          fee_acceptance: 'depends_on_net_savings',
          next_step: 'review_terms_then_consider',
          early_access_interest: 'yes',
          email: 'user@example.com',
          open_feedback: 'x'
        },
        routing: { opted_for_contact: true },
        metadata: { submitted_at_utc: '2026-10-17T00:00:00.000Z' },
        source: 'survey',
        survey_name: 'start_your_path',
        title: 'Start Your Path'
      },
      context,
      sqlLib,
      getPoolFn: async () => ({ connected: true }),
      ensureNotDuplicateFn: async () => null,
      resetPoolFn: async () => {}
    }),
    /Queue message has invalid 2026.10 responses\./
  );

  assert.equal(warns.length, 1);
  assert.equal(warns[0].details.client_submission_id, 'abababab-abab-4bab-8bab-abababababab');
  assert.equal(warns[0].details.resolved_survey_version, '2026.10');
  assert.equal(warns[0].details.error_category, 'invalid_message');
  assert.deepEqual(Object.keys(warns[0].details).sort(), ['client_submission_id', 'error_category', 'resolved_survey_version']);
});

test('duplicate detected before transaction creation returns success without launching transaction or inserts', async () => {
  let beginCalled = false;
  let insertCalls = 0;

  const sqlLib = {
    MAX: 2147483647,
    UniqueIdentifier: 'uniqueidentifier',
    NVarChar: () => 'nvarchar',
    Bit: 'bit',
    Request: function Request() {
      return {
        input() {},
        async query() {
          insertCalls += 1;
        }
      };
    },
    Transaction: function Transaction() {
      return {
        async begin() { beginCalled = true; },
        async rollback() {},
        async commit() {}
      };
    }
  };

  const result = await processSurveySubmissionQueue({
    queueMessage: {
      client_submission_id: '99999999-9999-4999-8999-999999999999',
      queued_at_utc: '2026-10-17T00:00:00.000Z',
      responses: { journey_stage: 'just_exploring', current_needs: ['debt_reduction'] },
      routing: { opted_for_contact: false },
      metadata: { submitted_at_utc: '2026-10-17T00:00:00.000Z' },
      source: 'survey',
      survey_name: 'start_your_path',
      title: 'Start Your Path'
    },
    context: createContext(),
    sqlLib,
    getPoolFn: async () => ({ connected: true }),
    ensureNotDuplicateFn: async () => 'duplicate-already-exists',
    resetPoolFn: async () => {},
    buildSelectionRowsFn: () => [{ question_code: 'current_needs', option_value: 'debt_reduction' }],
    randomUUIDFn: () => '12345678-1234-4123-8123-123456789012'
  });

  assert.equal(result.outcome, 'duplicate_skipped');
  assert.equal(beginCalled, false);
  assert.equal(insertCalls, 0);
});

test('queue parser accepts object and string payloads for existing queue contract', () => {
  const objectMessage = { client_submission_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' };
  const stringMessage = JSON.stringify(objectMessage);

  assert.deepEqual(parseQueueMessage(objectMessage), objectMessage);
  assert.deepEqual(parseQueueMessage(stringMessage), objectMessage);
  assert.equal(isValidQueueClientId(objectMessage.client_submission_id), true);
});
