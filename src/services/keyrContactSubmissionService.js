const sql = require('mssql');

const CONTACT_TOPIC_CATEGORY_MAP = {
  'General Information': 'General Question',
  'Product Question': 'Product Comparison Question',
  'Application Assistance': 'Application Status',
  'Technical Website Issue': 'Technical Support',
  'Bank or Program Partnership': 'Partnership Inquiry',
  'Employer or University Partnership': 'Partnership Inquiry',
  'Community or Nonprofit Partnership': 'Partnership Inquiry',
  'Grant or Funding Opportunity': 'Grant / Sponsorship Inquiry',
  'Investment Inquiry': 'Other',
  'Press or Media': 'Media Inquiry',
  'Privacy or Security': 'Privacy / Data Question',
  Other: 'Other'
};

const REFERENCE_COLUMN_CANDIDATES = [
  'reference_id',
  'referenceid',
  'submission_reference_id',
  'submission_id',
  'submissionid',
  'contact_reference_id',
  'reference'
];

const ORGANIZATION_COLUMN_CANDIDATES = [
  'organization',
  'organization_name',
  'company_name',
  'company',
  'org_name'
];

let sqlConnectionFactory = null;
let notificationAdapter = {
  notifyContactTeam: async () => ({
    accepted: false,
    available: false,
    provider: 'none',
    status: 'unavailable',
    reason: 'provider_unavailable'
  })
};

function setSqlConnectionFactory(factory) {
  sqlConnectionFactory = typeof factory === 'function' ? factory : null;
}

function setNotificationAdapter(adapter) {
  if (adapter && typeof adapter.notifyContactTeam === 'function') {
    notificationAdapter = adapter;
    return;
  }
  notificationAdapter = {
    notifyContactTeam: async () => ({
      accepted: false,
      available: false,
      provider: 'none',
      status: 'unavailable',
      reason: 'provider_unavailable'
    })
  };
}

function resetNotificationAdapter() {
  notificationAdapter = {
    notifyContactTeam: async () => ({
      accepted: false,
      available: false,
      provider: 'none',
      status: 'unavailable',
      reason: 'provider_unavailable'
    })
  };
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function generateReferenceId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const shard = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `KEYR-${stamp}-${shard}`;
}

function normalizeTopicForCategory(topic) {
  const safeTopic = String(topic || '').trim();
  return CONTACT_TOPIC_CATEGORY_MAP[safeTopic] || 'General Question';
}

function getNormalizedColumnName(columnName) {
  return String(columnName || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function pickColumn(columns, candidates) {
  const normalized = new Set(columns.map((column) => getNormalizedColumnName(column)));
  for (const candidate of candidates) {
    if (normalized.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function getTableColumns(pool) {
  const result = await pool.request().query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME = 'ContactSupportSubmissions';
  `);
  return (result && Array.isArray(result.recordset) ? result.recordset : []).map((row) => row.COLUMN_NAME || row.column_name || row.Column_name || '');
}

function buildInternalMessage({ name, email, phone, organization, topic, message }) {
  const lines = [
    `Name: ${String(name || '').trim()}`,
    `Email: ${String(email || '').trim()}`,
    `Topic: ${String(topic || '').trim()}`
  ];
  if (phone) lines.push(`Phone: ${String(phone).trim()}`);
  if (organization) lines.push(`Organization: ${String(organization).trim()}`);
  lines.push(`Message:\n${String(message || '').trim()}`);
  return lines.join('\n');
}

async function notifyContactTeam(submission) {
  return notificationAdapter.notifyContactTeam(submission);
}

async function submitContactRequest({ name, email, phone, organization, topic, message, consent, source = 'KEYR Concierge' }) {
  if (!source) {
    return { ok: false, status: 400, reason: 'missing_source', stored: false, notificationSent: false, delivered: false, deliveryStatus: 'failed', source: 'KEYR Concierge' };
  }

  if (!name || !email || !topic || !message) {
    return { ok: false, status: 400, reason: 'missing_required_fields', stored: false, notificationSent: false, delivered: false, deliveryStatus: 'failed', source };
  }

  if (!isValidEmail(email)) {
    return { ok: false, status: 400, reason: 'invalid_email', stored: false, notificationSent: false, delivered: false, deliveryStatus: 'failed', source };
  }

  if (consent !== true) {
    return { ok: false, status: 200, reason: 'missing_consent', stored: false, notificationSent: false, delivered: false, deliveryStatus: 'failed', source };
  }

  const connectionString = process.env.KEYR_DB_CONNECTION;
  if (!connectionString) {
    return {
      ok: false,
      status: 200,
      stored: false,
      notificationSent: false,
      delivered: false,
      deliveryStatus: 'failed',
      reason: 'submission_failed',
      source
    };
  }

  const referenceId = generateReferenceId();
  const category = normalizeTopicForCategory(topic);
  const internalMessage = buildInternalMessage({ name, email, phone, organization, topic, message });

  let pool;
  let referencePersisted = false;
  let notificationOutcome = null;

  try {
    const connectionFactory = sqlConnectionFactory || sql.connect;
    pool = await connectionFactory(connectionString);
    const columns = await getTableColumns(pool);
    const referenceColumn = pickColumn(columns, REFERENCE_COLUMN_CANDIDATES);
    const organizationColumn = pickColumn(columns, ORGANIZATION_COLUMN_CANDIDATES);

    const request = pool.request()
      .input('first_name', sql.NVarChar(100), String(name).trim())
      .input('last_name', sql.NVarChar(100), null)
      .input('email', sql.NVarChar(255), String(email).trim())
      .input('phone', sql.NVarChar(50), phone ? String(phone).trim() : null)
      .input('category', sql.NVarChar(100), category)
      .input('comparison_type', sql.NVarChar(150), null)
      .input('subject', sql.NVarChar(200), `KEYR Concierge: ${String(topic).trim()}`)
      .input('message', sql.NVarChar(sql.MAX), internalMessage)
      .input('wants_updates', sql.Bit, false)
      .input('auto_response_sent', sql.Bit, false)
      .input('auto_response_category', sql.NVarChar(100), category)
      .input('source_page', sql.NVarChar(200), 'public/keyr-concierge')
      .input('user_agent', sql.NVarChar(500), source || 'KEYR Concierge');

    if (referenceColumn) {
      request.input(referenceColumn, sql.NVarChar(100), referenceId);
    }
    if (organizationColumn) {
      request.input(organizationColumn, sql.NVarChar(200), organization ? String(organization).trim() : null);
    }

    const insertColumns = ['first_name', 'last_name', 'email', 'phone', 'category', 'comparison_type', 'subject', 'message', 'wants_updates', 'auto_response_sent', 'auto_response_category', 'source_page', 'user_agent'];
    const insertValues = ['@first_name', '@last_name', '@email', '@phone', '@category', '@comparison_type', '@subject', '@message', '@wants_updates', '@auto_response_sent', '@auto_response_category', '@source_page', '@user_agent'];

    if (referenceColumn) {
      insertColumns.push(referenceColumn);
      insertValues.push(`@${referenceColumn}`);
    }
    if (organizationColumn) {
      insertColumns.push(organizationColumn);
      insertValues.push(`@${organizationColumn}`);
    }

    await request.query(`
      INSERT INTO dbo.ContactSupportSubmissions (
        ${insertColumns.join(', ')}
      ) VALUES (
        ${insertValues.join(', ')}
      );
    `);

    referencePersisted = Boolean(referenceColumn);
    notificationOutcome = await notifyContactTeam({
      name,
      email,
      phone,
      organization,
      topic,
      category,
      message: internalMessage,
      source,
      referenceId
    });

    const notificationSent = Boolean(notificationOutcome && notificationOutcome.accepted === true);
    const delivered = Boolean(notificationSent && notificationOutcome && notificationOutcome.delivered === true);

    return {
      ok: true,
      status: 200,
      stored: true,
      notificationSent,
      delivered,
      deliveryStatus: 'stored_only',
      referenceId,
      source,
      referencePersisted,
      schemaMigrationRequired: !referencePersisted,
      providerStatus: notificationOutcome && notificationOutcome.status ? notificationOutcome.status : 'unavailable'
    };
  } catch (error) {
    return {
      ok: false,
      status: 200,
      stored: false,
      notificationSent: false,
      delivered: false,
      deliveryStatus: 'failed',
      reason: 'submission_failed',
      source
    };
  } finally {
    if (pool && typeof pool.close === 'function') {
      await pool.close();
    }
  }
}

module.exports = {
  submitContactRequest,
  setNotificationAdapter,
  resetNotificationAdapter,
  setSqlConnectionFactory
};
