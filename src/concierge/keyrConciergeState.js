const DEFAULT_MAX_TURNS = parseInt(process.env.KEYR_CONCIERGE_MAX_TURNS || '12', 10);
const DEFAULT_SESSION_TTL_MS = parseInt(process.env.KEYR_CONCIERGE_SESSION_TTL_MS || '1800000', 10);
const DEFAULT_RATE_LIMIT_MAX = parseInt(process.env.KEYR_CONCIERGE_RATE_LIMIT_MAX || '20', 10);
const DEFAULT_RATE_LIMIT_WINDOW_MS = parseInt(process.env.KEYR_CONCIERGE_RATE_LIMIT_WINDOW_MS || '60000', 10);

const conversationStore = new Map();
const rateLimitStore = new Map();

function generateConversationId() {
  return `public-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeConversationId(raw) {
  const value = String(raw || '').trim();
  if (!value || value.length > 200 || !/^[A-Za-z0-9\-_]+$/.test(value)) {
    return null;
  }
  return value;
}

function getStateConfig() {
  return {
    maxTurns: DEFAULT_MAX_TURNS,
    sessionTtlMs: DEFAULT_SESSION_TTL_MS,
    rateLimitMax: DEFAULT_RATE_LIMIT_MAX,
    rateLimitWindowMs: DEFAULT_RATE_LIMIT_WINDOW_MS
  };
}

function createConversationState(conversationId) {
  const now = new Date().toISOString();
  return {
    conversationId,
    activeTopic: null,
    currentKeyrProduct: null,
    comparisonEntities: [],
    previousIntent: null,
    lastKnowledgeIds: [],
    lastApprovedActions: [],
    contactFlowState: null,
    turnCount: 0,
    createdAtUtc: now,
    updatedAtUtc: now
  };
}

function getConversationState(conversationId) {
  const normalized = normalizeConversationId(conversationId);
  if (!normalized) {
    return null;
  }

  const state = conversationStore.get(normalized);
  if (!state) {
    return null;
  }

  const now = Date.now();
  const created = new Date(state.createdAtUtc).getTime();
  const age = now - created;
  if (age > getStateConfig().sessionTtlMs) {
    conversationStore.delete(normalized);
    return null;
  }

  return state;
}

function saveConversationState(state) {
  if (!state || !state.conversationId) {
    return null;
  }

  const normalized = normalizeConversationId(state.conversationId);
  if (!normalized) {
    return null;
  }

  const now = new Date().toISOString();
  state.updatedAtUtc = now;
  state.turnCount = Math.min(Number(state.turnCount || 0), getStateConfig().maxTurns);
  conversationStore.set(normalized, state);
  return state;
}

function ensureConversationState(conversationId) {
  const normalizedId = normalizeConversationId(conversationId) || generateConversationId();
  let state = getConversationState(normalizedId);
  if (!state) {
    state = createConversationState(normalizedId);
    saveConversationState(state);
  }
  return state;
}

function resolveConversationState(conversationId) {
  const normalizedId = normalizeConversationId(conversationId);
  if (!normalizedId) {
    return ensureConversationState(generateConversationId());
  }

  return getConversationState(normalizedId) || ensureConversationState(normalizedId);
}

function updateConversationState(state, updates = {}) {
  const merged = {
    ...(state || createConversationState(generateConversationId())),
    ...updates
  };

  merged.turnCount = Math.max(0, Number(merged.turnCount || 0));
  merged.updatedAtUtc = new Date().toISOString();
  if (!merged.createdAtUtc) {
    merged.createdAtUtc = merged.updatedAtUtc;
  }
  saveConversationState(merged);
  return merged;
}

function pruneTurnHistory(state) {
  if (!state) {
    return state;
  }

  const maxTurns = getStateConfig().maxTurns;
  if (state.turnCount > maxTurns) {
    state.turnCount = maxTurns;
  }

  if (Array.isArray(state.lastKnowledgeIds)) {
    state.lastKnowledgeIds = state.lastKnowledgeIds.slice(-8);
  }

  if (Array.isArray(state.lastApprovedActions)) {
    state.lastApprovedActions = state.lastApprovedActions.slice(-8);
  }

  return state;
}

function checkRateLimit(clientKey, options = {}) {
  const key = String(clientKey || 'anonymous');
  const config = getStateConfig();
  const max = Number(options.max ?? config.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX);
  const windowMs = Number(options.windowMs ?? config.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS);
  const now = Date.now();
  const entries = rateLimitStore.get(key) || [];
  const recent = entries.filter((entry) => now - entry <= windowMs);

  if (recent.length >= max) {
    return {
      allowed: false,
      retryAfterMs: Math.max(0, windowMs - (now - recent[0]))
    };
  }

  recent.push(now);
  rateLimitStore.set(key, recent);
  return { allowed: true, retryAfterMs: 0 };
}

function clearRateLimit(clientKey) {
  if (clientKey) {
    rateLimitStore.delete(String(clientKey));
  }
}

module.exports = {
  conversationStore,
  rateLimitStore,
  getStateConfig,
  createConversationState,
  getConversationState,
  saveConversationState,
  ensureConversationState,
  resolveConversationState,
  updateConversationState,
  pruneTurnHistory,
  generateConversationId,
  normalizeConversationId,
  checkRateLimit,
  clearRateLimit
};
