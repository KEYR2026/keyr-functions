const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  generateClientSubmissionId,
  isValidClientSubmissionId,
  buildQueueMessage,
  enqueueSurveySubmission
} = require('../src/functions/survey.js');

const {
  parseQueueMessage,
  isValidClientSubmissionId: isValidQueueClientId,
  buildSelectionRows,
  classifyError,
  isUniqueKeyConflict,
  processSurveySubmissionQueue
} = require('../src/functions/processSurveySubmission.js');

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
