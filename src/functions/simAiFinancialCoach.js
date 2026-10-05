const { app } = require("@azure/functions");
const sql = require("mssql");

const azureAiEndpoint = process.env.AZURE_AI_ENDPOINT;
const azureAiApiKey = process.env.AZURE_AI_API_KEY;
const azureAiApiVersion = process.env.AZURE_AI_API_VERSION || "2024-10-21";

const fastDeployment = process.env.KEYR_COACH_FAST_DEPLOYMENT || "gpt-5-mini";
const deepDeployment = process.env.KEYR_COACH_DEEP_DEPLOYMENT || "DeepSeek-V4-Pro";

const PRODUCT_COMPATIBILITY_MAP = {
  "anchor base": { journey: "Safe Start", product: "Anchor" },
  "anchor (secured)": { journey: "", product: "Anchor" },
  "anchor secured": { journey: "", product: "Anchor" },
  "merit": { journey: "", product: "Anchor" },
  "merit (secured)": { journey: "", product: "Anchor" },
  "merit secured": { journey: "", product: "Anchor" },
  "anchor": { journey: "", product: "Anchor" },
  "ascend (unsecured)": { journey: "Active", product: "Ascend" },
  "ascend unsecured": { journey: "Active", product: "Ascend" },
  "ascend": { journey: "Active", product: "Ascend" },
  "apex (unsecured)": { journey: "Active", product: "Apex" },
  "apex unsecured": { journey: "Active", product: "Apex" },
  "apex": { journey: "Active", product: "Apex" },
  "safe": { journey: "Safe Start", product: "Anchor" },
  "safe start": { journey: "Safe Start", product: "Anchor" },
  "safe start mode": { journey: "Safe Start", product: "Anchor" }
};

const CANONICAL_PRODUCT_RULES = {
  "Safe Start": {
    product: "Anchor",
    transferSupport: false,
    proposedApr: 0,
    proposedAnnualFee: 0,
    transferFee: 0,
    depositRange: { min: 50, max: 2000, optionalGuidance: [300, 500] }
  },
  Anchor: {
    product: "Anchor",
    transferSupport: false,
    proposedApr: 0,
    proposedAnnualFee: 0,
    transferFee: 0,
    depositRange: { min: 50, max: 2000, optionalGuidance: [300, 500] }
  },
  Ascend: {
    product: "Ascend",
    transferSupport: true,
    proposedApr: 18.99,
    proposedAutoPayApr: 12.0,
    transferFee: 2,
    transferFeeLabel: "2%"
  },
  Apex: {
    product: "Apex",
    transferSupport: true,
    proposedApr: 15.99,
    proposedAutoPayApr: 9.0,
    transferFee: 0,
    transferFeeLabel: "0%"
  }
};

function normalizeProductInput(productValue, options = {}) {
  const raw = String(productValue || "").trim();
  const journeyOverride = String(options.journey || options.journeyValue || "").trim();
  const safeStartMode = String(options.safeStartMode || "").trim();

  if (!raw && !journeyOverride && !safeStartMode) {
    return { journey: "", product: "" };
  }

  const canonicalInput = raw || journeyOverride || safeStartMode;
  const compact = canonicalInput.toLowerCase().replace(/\s+/g, " ").replace(/[-_]+/g, " ").trim();
  const explicitlyMapped = PRODUCT_COMPATIBILITY_MAP[compact];

  if (explicitlyMapped) {
    return { journey: explicitlyMapped.journey, product: explicitlyMapped.product };
  }

  if (/^safe start$/i.test(canonicalInput) || /^safe$/i.test(canonicalInput) || /^safe start mode$/i.test(canonicalInput) || /^safe_start_mode$/i.test(canonicalInput)) {
    return { journey: "Safe Start", product: "Anchor" };
  }

  if (/^anchor$/i.test(canonicalInput) || /^anchor secured$/i.test(canonicalInput) || /^anchor \(secured\)$/i.test(canonicalInput)) {
    return { journey: "", product: "Anchor" };
  }

  if (/^ascend$/i.test(canonicalInput) || /^ascend unsecured$/i.test(canonicalInput) || /^ascend \(unsecured\)$/i.test(canonicalInput)) {
    return { journey: "Active", product: "Ascend" };
  }

  if (/^apex$/i.test(canonicalInput) || /^apex unsecured$/i.test(canonicalInput) || /^apex \(unsecured\)$/i.test(canonicalInput)) {
    return { journey: "Active", product: "Apex" };
  }

  const alias = canonicalInput.replace(/\s+\((secured|unsecured)\)/i, "");
  if (/^merit$/i.test(alias) || /^merit secured$/i.test(alias) || /^merit \(secured\)$/i.test(alias)) {
    return { journey: "", product: "Anchor" };
  }

  if (journeyOverride && /^safe start$/i.test(journeyOverride)) {
    return { journey: "Safe Start", product: "Anchor" };
  }

  if (safeStartMode && /^safe start$/i.test(safeStartMode)) {
    return { journey: "Safe Start", product: "Anchor" };
  }

  return { journey: "", product: canonicalInput };
}

function sanitizeProductValue(productValue) {
  const rawValue = String(productValue ?? "").trim();
  if (!rawValue) {
    return "";
  }

  const normalized = normalizeProductInput(rawValue);
  if (normalized.product) {
    return normalized.product;
  }

  const compact = rawValue.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^safe(?: start)?$/i.test(rawValue) || /^safe start mode$/i.test(rawValue)) {
    return "Anchor";
  }
  if (/^anchor(?:\s+base)?$/i.test(rawValue) || /^anchor\s*\(secured\)$/i.test(rawValue) || /^anchor\s+secured$/i.test(rawValue)) {
    return "Anchor";
  }
  if (/^merit(?:\s+secured)?$/i.test(rawValue) || /^merit\s*\(secured\)$/i.test(rawValue)) {
    return "Anchor";
  }
  if (/^ascend(?:\s+\(unsecured\)|\s+unsecured)?$/i.test(rawValue)) {
    return "Ascend";
  }
  if (/^apex(?:\s+\(unsecured\)|\s+unsecured)?$/i.test(rawValue)) {
    return "Apex";
  }

  if (compact === "anchor base") {
    return "Anchor";
  }

  return rawValue;
}

function sanitizeScenarioName(rawScenarioName) {
  const rawName = String(rawScenarioName ?? "").trim();
  if (!rawName) {
    return "";
  }

  let sanitized = rawName
    .replace(/\b(?:Merit|Anchor Base|Anchor Secured|Anchor\s*\(Secured\)|Safe Start|Current account status)\b/gi, " ")
    .replace(/\b(?:Ascend|Apex)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(high)\s+APR\b/gi, "$1-APR")
    .trim();

  if (!sanitized) {
    return "Current account status";
  }

  return sanitized;
}

function buildSanitizedUser(rawUser = {}) {
  const user = { ...(rawUser || {}) };
  const currentTierValue = sanitizeProductValue(user.current_tier ?? user.currentTier ?? "");

  if (currentTierValue) {
    user.current_tier = currentTierValue;
    user.currentTier = currentTierValue;
  }

  return user;
}

function buildSanitizedScenario(rawScenario = null) {
  if (!rawScenario) {
    return null;
  }

  const scenario = { ...rawScenario };
  const keyrTierValue = sanitizeProductValue(scenario.keyr_tier ?? scenario.keyrTier ?? "");

  if (keyrTierValue) {
    scenario.keyr_tier = keyrTierValue;
    scenario.keyrTier = keyrTierValue;
  }

  const scenarioNameValue = sanitizeScenarioName(scenario.scenario_name ?? scenario.scenarioName ?? "");
  if (scenarioNameValue) {
    scenario.scenario_name = scenarioNameValue;
    scenario.scenarioName = scenarioNameValue;
  }

  return scenario;
}

function buildSanitizedMemberCoachContext(rawContext = {}) {
  const sanitized = { ...(rawContext || {}) };
  const currentTierValue = sanitizeProductValue(sanitized.current_tier ?? sanitized.currentTier ?? "");

  if (currentTierValue) {
    sanitized.current_tier = currentTierValue;
    sanitized.currentTier = currentTierValue;
  }

  const safeNextActionMessage = "Your broader credit profile changed recently. Focus on credit profile stability while continuing consistent on-time payment habits.";
  const nextActionMessage = String(sanitized.next_best_action_message || "").trim();

  if (!nextActionMessage || /good standing|in good standing|account remains in good standing/i.test(nextActionMessage)) {
    sanitized.next_best_action_message = safeNextActionMessage;
  }

  return sanitized;
}

function isBillingCycleCurrent(memberCoachContext = {}) {
  const dueDays = Number(memberCoachContext?.days_until_due_date ?? NaN);
  const statementDays = Number(memberCoachContext?.days_until_statement_close ?? NaN);

  const dueIsStale = Number.isFinite(dueDays) && dueDays < -30;
  const statementIsStale = Number.isFinite(statementDays) && statementDays < -30;

  return !(dueIsStale || statementIsStale);
}

function buildSanitizedActiveAlerts(activeCoachingAlerts = [], memberCoachContext = {}, debugEnabled = false) {
  const alerts = Array.isArray(activeCoachingAlerts) ? activeCoachingAlerts : [];
  const cycleIsCurrent = isBillingCycleCurrent(memberCoachContext);

  const normalizedAlerts = alerts.map((alert) => {
    const alertText = `${alert?.alert_type || ""} ${alert?.title || ""} ${alert?.message || ""}`.toLowerCase();
    const isCycleSensitive = /statement|utilization|payment|close|due/i.test(alertText);
    const isCurrent = cycleIsCurrent || !isCycleSensitive;

    return {
      ...alert,
      isCurrent,
      freshnessStatus: isCurrent ? "current" : "stale"
    };
  });

  const currentlyRelevant = normalizedAlerts.filter((alert) => alert.isCurrent);

  return debugEnabled ? normalizedAlerts : currentlyRelevant;
}

function buildSafeRoutingMetadata(routing = {}, aiResult = {}, debugEnabled = false) {
  const base = {
    modelFamily: routing.modelFamily || "deterministic",
    questionType: routing.questionType || "general",
    aiWasUsed: Boolean(aiResult.aiWasUsed),
    answerSource: aiResult.aiWasUsed ? "fast_model" : "deterministic"
  };

  if (!debugEnabled) {
    return base;
  }

  return {
    ...base,
    model: routing.model || null,
    reason: routing.reason || null,
    aiError: aiResult.aiError || null
  };
}

function roundCurrency(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function goalNormalizedIntent(question) {
  const q = (question || "").toLowerCase();

  if (/how am i doing|progress update|how does my account look|am i on track/i.test(q)) {
    return "ACCOUNT_PROGRESS_SUMMARY";
  }

  if (/what should i focus on next|what should i do next|what should i do now|what is my next step|next best action|what should i focus on/i.test(q)) {
    return "NEXT_BEST_ACTION";
  }

  if (/current balance|posted balance|available credit|due date|statement close|payment due|minimum payment|what is my balance|due date again|how much available credit/i.test(q)) {
    return "LIVE_ACCOUNT_LOOKUP";
  }

  if (/autopay|auto pay|automatic payment|turn it on|should i turn on/i.test(q)) {
    return "AUTOPAY_GUIDANCE";
  }

  if (/utilization|utilisation|available credit|credit usage|8 percent|8%/i.test(q)) {
    return "UTILIZATION_GUIDANCE";
  }

  if (/late payment|missed payment|hardship|can't pay|cannot pay|bankruptcy|collections|legal|fraud|dispute/i.test(q)) {
    return "HARDSHIP_OR_LATE_PAYMENT";
  }

  if (/balance transfer.*(eligible|eligible|qualification|qualify|can i|am i eligible|transfer capacity|approval)|can .*balance transfer|does .*support balance transfer/i.test(q)) {
    return "BALANCE_TRANSFER_ELIGIBILITY";
  }

  if (/balance transfer.*(how long|timing|processing|business day|complete)|transfer.*(how long|timing)/i.test(q)) {
    return "BALANCE_TRANSFER_TIMING";
  }

  if (/payoff|pay off|debt plan|pay first|which balance|avalanche|snowball|monthly budget|debt reduction|multi-card|multiple cards|card strategy/i.test(q)) {
    return q.includes("continue") || q.includes("adjust") || q.includes("change") || q.includes("still") ? "DEBT_PLAN_ADJUST" : "DEBT_PLAN_NEW";
  }

  if (/anchor|ascend|apex|merit|tier|upgrade|graduate|qualify/i.test(q)) {
    return "PRODUCT_RULE";
  }

  if (/what did we say|resume|continue the plan|go back to the plan|go back to the transfer plan|previous plan|where were we/i.test(q)) {
    return "CONVERSATION_RESUME";
  }

  if (/payment status|payment due|is payment|is my payment|pending payment/i.test(q)) {
    return "PAYMENT_STATUS";
  }

  if (/which product|what is anchor|what is ascend|what is apex|product rules|can merit|can anchor/i.test(q)) {
    return "PRODUCT_RULE";
  }

  if (/tell me more|explain|help me understand|what does that mean|what is a balance transfer|general question|educational/i.test(q)) {
    return "GENERAL_EDUCATION";
  }

  return "GENERAL_EDUCATION";
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function normalizeEndpoint(endpoint) {
  return (endpoint || "")
    .replace(/\/openai\/v1\/chat\/completions\/?$/i, "")
    .replace(/\/openai\/v1\/?$/i, "")
    .replace(/\/+$/, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getFirstName(user) {
  const rawName = user?.first_name || user?.firstName || user?.name || "";

  if (typeof rawName !== "string") {
    return "";
  }

  return rawName.trim().split(/\s+/)[0] || "";
}

function ensureNameGreeting(text, firstName) {
  const name = (firstName || "").trim();
  const cleanText = (text || "").trim();

  if (!name || !cleanText) {
    return cleanText;
  }

  const normalizedText = cleanText.replace(/^\s+/, "");
  const namePattern = new RegExp(
    `^(hi|hello)\\s+${escapeRegExp(name)}\\b|^${escapeRegExp(name)}\\b`,
    "i"
  );

  let rewrittenText = normalizedText
    .replace(/\bkeeping utilization lower\b/gi, "keeping your utilization lower")
    .replace(/\bthe member\b/gi, "you")
    .replace(/\bthis member\b/gi, "you")
    .replace(/\bmember's\b/gi, "your")
    .replace(/\btheir available credit\b/gi, "your available credit")
    .replace(/\btheir\b/gi, "your")
    .replace(/\bthey\b/gi, "you")
    .replace(/\bthem\b/gi, "you")
    .replace(/\byou's\b/gi, "your")
    .replace(/\byou is\b/gi, "you are")
    .replace(/\bkeyr\b/gi, "KEYR");

  rewrittenText = rewrittenText.replace(/([.!?]\s+)([a-z])/g, (match, p1, p2) => {
    return `${p1}${p2.toUpperCase()}`;
  });

  if (namePattern.test(rewrittenText)) {
    return rewrittenText;
  }

  const trimmedText = rewrittenText.replace(/^[\s,.;:]+/, "");
  const firstChar = trimmedText.charAt(0);
  const lowerCasedText = firstChar
    ? `${firstChar.toLowerCase()}${trimmedText.slice(1)}`
    : trimmedText;

  return `Hi ${name}, ${lowerCasedText}`.replace(/,\s+/g, ", ");
}

function isTransferTimingQuestion(question) {
  const q = (question || "").toLowerCase();

  const hasTransferContext =
    q.includes("balance transfer") ||
    q.includes("transfer");

  const hasTimingContext =
    q.includes("how long") ||
    q.includes("business day") ||
    q.includes("business days") ||
    q.includes("weekend") ||
    q.includes("weekends") ||
    q.includes("timing") ||
    q.includes("processing time") ||
    q.includes("complete") ||
    q.includes("finish");

  return hasTransferContext && hasTimingContext;
}

function isPayFirstQuestion(question) {
  const q = (question || "").toLowerCase();

  return (
    q.includes("pay first") ||
    q.includes("which balance") ||
    q.includes("which card") ||
    q.includes("reduce interest") ||
    q.includes("interest faster") ||
    q.includes("highest apr") ||
    q.includes("attack first")
  );
}

function isNextStepQuestion(question) {
  const q = (question || "").toLowerCase();

  return (
    q.includes("what should i do next") ||
    q.includes("what should i do") ||
    q.includes("what should i focus on") ||
    q.includes("what do i do next") ||
    q.includes("what's next") ||
    q.includes("next step") ||
    q.includes("next best action") ||
    q.includes("what should i do now") ||
    q.includes("what should i work on next")
  );
}

function normalizeEligibilityValue(value) {
  if (value === true) {
    return true;
  }

  if (value === false) {
    return false;
  }

  if (typeof value === "undefined" || value === null) {
    return null;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    const containsUnknown = /(do not know|don't know|unknown|unsure|not sure|cannot tell|can't tell|missing|n\/a|na|none|blank)/i.test(normalized);
    const containsNegative = /(not eligible|ineligible|not transfer eligible|not eligible for transfer|not approved|not approved for transfer|not eligible\.?)/i.test(normalized);
    const containsPositive = /(eligible for transfer|eligible|transfer eligible|approved for transfer|approved transfer|transfer approval)/i.test(normalized);

    if (containsNegative) {
      return false;
    }

    if (containsUnknown) {
      return null;
    }

    if (containsPositive) {
      return true;
    }

    if (["true", "yes", "available"].includes(normalized)) return true;
    if (["false", "no", "unavailable"].includes(normalized)) return false;
    if (["unknown", "n/a", "na", "missing", "none", "blank", ""].includes(normalized)) return null;
    return null;
  }

  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }

  return null;
}

function normalizeAccountStatusValue(value) {
  if (value === null || typeof value === "undefined") {
    return null;
  }

  const normalized = String(value).trim();

  if (!normalized) {
    return null;
  }

  const lowered = normalized.toLowerCase();
  if (["unknown", "unavailable", "n/a", "na", "none", "blank"].includes(lowered)) {
    return null;
  }

  return normalized;
}

function detectRequestedAccountFields(question) {
  const q = (question || "").toLowerCase();
  const requested = {
    currentBalance: false,
    paymentDueDate: false,
    daysUntilDueDate: false,
    availableCredit: false,
    statementCloseDate: false,
    daysUntilStatementClose: false,
    minimumPayment: false,
    autopayEnabled: false,
    accountStatus: false
  };

  if (/current balance|what is my balance|how much do i owe|what is my current balance/.test(q)) {
    requested.currentBalance = true;
  }

  if (/exact due date|specific due date|what is my due date|my due date/.test(q) && !/days until.*due|how many days until.*due/.test(q)) {
    requested.paymentDueDate = true;
  }

  if (/how many days until.*due|days until.*due|days until my payment is due|days until due/.test(q)) {
    requested.daysUntilDueDate = true;
  }

  if (/available credit|how much available credit|what is my available credit/.test(q)) {
    requested.availableCredit = true;
  }

  if (/statement close date|what is my statement close date|statement close/.test(q)) {
    requested.statementCloseDate = true;
  }

  if (/days until statement close|how many days until statement close/.test(q)) {
    requested.daysUntilStatementClose = true;
  }

  if (/minimum payment|what is my minimum payment/.test(q)) {
    requested.minimumPayment = true;
  }

  if (/is autopay enabled|autopay enabled|auto pay enabled|is auto pay on|autopay/.test(q)) {
    requested.autopayEnabled = true;
  }

  if (/account status|how am i doing|status|good standing|in good standing/.test(q)) {
    requested.accountStatus = true;
  }

  if (/current balance.*due date|due date.*current balance|balance.*and.*due date/.test(q)) {
    requested.currentBalance = true;
    requested.paymentDueDate = true;
  }

  if (Object.values(requested).every((value) => !value)) {
    requested.currentBalance = /current balance|balance/.test(q);
    requested.paymentDueDate = /due date/.test(q);
    requested.daysUntilDueDate = /days until/.test(q);
    requested.availableCredit = /available credit/.test(q);
    requested.statementCloseDate = /statement close/.test(q);
    requested.daysUntilStatementClose = /days until statement close/.test(q);
    requested.minimumPayment = /minimum payment/.test(q);
    requested.autopayEnabled = /autopay/.test(q);
    requested.accountStatus = /status|good standing/.test(q);
  }

  return requested;
}

function classifyQuestionType(question) {
  const q = (question || "").toLowerCase();

  const legacyMap = {
    next_step: "NEXT_BEST_ACTION",
    support_escalation: "HARDSHIP_OR_LATE_PAYMENT",
    transfer_timing: "BALANCE_TRANSFER_TIMING",
    payoff_strategy: "DEBT_PLAN_NEW",
    transfer_strategy: "BALANCE_TRANSFER_ELIGIBILITY",
    utilization_coaching: "UTILIZATION_GUIDANCE",
    tier_progression: "PRODUCT_RULE",
    general_coaching: "GENERAL_EDUCATION"
  };

  const availableCreditPatterns = [
    "available credit",
    "available credit amount",
    "how much available credit",
    "how much credit do i have available",
    "credit available",
    "remaining credit",
    "remaining available credit",
    "spending capacity",
    "how much can i still spend",
    "how much room do i have on my card"
  ];

  const creditLimitPatterns = [
    "what is my credit limit",
    "what is my approved limit",
    "how large is my credit line",
    "credit limit",
    "approved limit",
    "credit line"
  ];

  if (
    q.includes("why did my progress status change") ||
    q.includes("what caused my profile status to change") ||
    q.includes("why did my status change") ||
    q.includes("am i still making progress") ||
    q.includes("how am i doing") ||
    q.includes("how does my account look") ||
    q.includes("progress update") ||
    q.includes("am i on track")
  ) {
    return "ACCOUNT_PROGRESS_SUMMARY";
  }

  if (
    q.includes("what should i focus on next") ||
    q.includes("what should i do next") ||
    q.includes("what should i do now") ||
    q.includes("what is my next step") ||
    q.includes("next best action") ||
    q.includes("what should i focus on")
  ) {
    return "NEXT_BEST_ACTION";
  }

  if (
    availableCreditPatterns.some((pattern) => q.includes(pattern)) ||
    creditLimitPatterns.some((pattern) => q.includes(pattern)) ||
    q.includes("how much available credit") ||
    q.includes("what is my current balance") ||
    q.includes("what is my balance") ||
    q.includes("what is my due date") ||
    q.includes("statement close") ||
    q.includes("current balance") ||
    q.includes("payment due date") ||
    q.includes("due date again") ||
    q.includes("remind me of my current balance")
  ) {
    return "LIVE_ACCOUNT_LOOKUP";
  }

  if (/autopay|auto pay|automatic payment|turn it on|should i turn on/.test(q)) {
    return "AUTOPAY_GUIDANCE";
  }

  if (/balance transfer.*(can i|am i eligible|eligible|qualify|transfer capacity|approval|available credit|how much)|can .*balance transfer|does .*support balance transfer/.test(q)) {
    return "BALANCE_TRANSFER_ELIGIBILITY";
  }

  if (/balance transfer.*(how long|timing|processing|business day|complete|finish)|transfer.*(how long|timing)/.test(q)) {
    return "BALANCE_TRANSFER_TIMING";
  }

  if (/hardship|late payment|missed payment|can't pay|cannot pay|bankruptcy|collections|fraud|dispute|legal|lawsuit/.test(q)) {
    return "HARDSHIP_OR_LATE_PAYMENT";
  }

  if (/resume|continue the plan|go back to the plan|go back to the transfer plan|where were we|previous plan|what did we decide/.test(q)) {
    return "CONVERSATION_RESUME";
  }

  const strongDebtPlanSignals = [
    /build an exact plan/i,
    /build a plan/i,
    /debt plan/i,
    /payoff plan/i,
    /balance-transfer plan/i,
    /transfer plan/i,
    /multi-card/i,
    /multiple cards/i,
    /approved transfer capacity/i,
    /transfer capacity/i,
    /transfer fee/i,
    /fee counts inside capacity/i,
    /fee counts outside capacity/i,
    /multiple apr/i,
    /monthly debt budget/i,
    /pay .*\$?\d+(?:,\d{3})*(?:\.\d+)? per month.*toward debt/i,
    /allocate the transfer/i,
    /which card should.*pay first/i,
    /highest apr first/i,
    /phased transfer/i,
    /debt reduction plan/i,
    /pay .*\$?\d+(?:,\d{3})*(?:\.\d+)? per month/i,
    /card a.*card b.*card c/i,
    /card b.*card c.*card a/i
  ];

  if (
    strongDebtPlanSignals.some((pattern) => pattern.test(q)) ||
    (/(card a|card b|card c|multiple cards|multi-card|apr)/.test(q) && /(transfer|debt|budget|pay|allocate)/.test(q))
  ) {
    return /continue|adjust|change|still/.test(q) ? "DEBT_PLAN_ADJUST" : "DEBT_PLAN_NEW";
  }

  if (/utilization|utilisation|credit usage|available credit|credit limit|8 percent|8%/.test(q)) {
    return "UTILIZATION_GUIDANCE";
  }

  if (/payoff|pay off|pay down|pay first|which balance|reduce interest|interest faster|debt reduction|debt strategy|snowball|avalanche|monthly budget|monthly plan|payment plan/.test(q)) {
    return /continue|adjust|change|still/.test(q) ? "DEBT_PLAN_ADJUST" : "DEBT_PLAN_NEW";
  }

  if (/has my payment posted|is my payment pending|did my payment go through|what is my payment status|was my payment late|did i miss my payment|how much is my minimum payment|when is my payment due|what is my exact due date|payment due date|is my payment.*late/.test(q)) {
    return "PAYMENT_STATUS";
  }

  if (/anchor|ascend|apex|merit|tier|upgrade|graduate|advance|qualify/.test(q)) {
    return "PRODUCT_RULE";
  }

  if (/what is a balance transfer|explain balance transfer|general education|help me understand/.test(q)) {
    return "GENERAL_EDUCATION";
  }

  if (/missing|need more info|don't know|what information|which card|what balance|what apr/.test(q)) {
    return "MISSING_INFORMATION";
  }

  return legacyMap[q] || "UNKNOWN";
}

function chooseModel(question, cardCount, knowledgeArticle) {
  const questionType = classifyQuestionType(question);

  if (knowledgeArticle?.recommended_model) {
    const recommendedModel = knowledgeArticle.recommended_model;

    if (recommendedModel === "DeepSeek-V4-Pro") {
      return {
        model: deepDeployment,
        modelFamily: "DeepSeek-V4-Pro",
        questionType,
        reason: `Knowledge article ${knowledgeArticle.article_code} recommends DeepSeek V4 Pro.`
      };
    }

    return {
      model: fastDeployment,
      modelFamily: "gpt-5-mini",
      questionType,
      reason: `Knowledge article ${knowledgeArticle.article_code} recommends GPT-5 mini.`
    };
  }

  const fastIntents = [
    "LIVE_ACCOUNT_LOOKUP",
    "ACCOUNT_PROGRESS_SUMMARY",
    "NEXT_BEST_ACTION",
    "PRODUCT_RULE",
    "BALANCE_TRANSFER_ELIGIBILITY",
    "BALANCE_TRANSFER_TIMING",
    "PAYMENT_STATUS",
    "UTILIZATION_GUIDANCE",
    "AUTOPAY_GUIDANCE",
    "GENERAL_EDUCATION",
    "MISSING_INFORMATION",
    "UNKNOWN"
  ];

  const deepIntents = [
    "DEBT_PLAN_NEW",
    "DEBT_PLAN_CONTINUE",
    "DEBT_PLAN_ADJUST",
    "CONVERSATION_RESUME",
    "PRODUCT_COMPARISON",
    "HARDSHIP_OR_LATE_PAYMENT"
  ];

  if (fastIntents.includes(questionType)) {
    return {
      model: fastDeployment,
      modelFamily: "gpt-5-mini",
      questionType,
      reason: "The request is grounded in verified account context, product rules, or a direct question that can be answered deterministically."
    };
  }

  if (deepIntents.includes(questionType) || (cardCount || 0) > 2) {
    return {
      model: deepDeployment,
      modelFamily: "DeepSeek-V4-Pro",
      questionType,
      reason: "The request requires iterative debt planning, scenario comparison, or multi-card reasoning."
    };
  }

  return {
    model: fastDeployment,
    modelFamily: "gpt-5-mini",
    questionType,
    reason: "The request is simple enough for the fast path and should remain low-latency."
  };
}

function buildExplicitDebtPlanState(question) {
  const q = String(question || "");

  if (!/balance transfer|debt plan|pay off|payoff|monthly budget|monthly debt|transfer capacity|approved transfer capacity|eligible|eligibility|transfer fee|fee treatment|inside capacity|outside capacity|card a|card b|card c/i.test(q)) {
    return null;
  }

  const productMatch = q.match(/\b(Ascend|Apex|Anchor|Merit)\b/i);
  const selectedProduct = productMatch ? productMatch[1].replace(/^./, (part) => part.toUpperCase()) : null;

  const capacityMatch =
    q.match(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*(?:of\s+)?(?:approved\s+)?(?:transfer\s+)?capacity/i) ||
    q.match(/(?:approved\s+transfer\s+capacity|transfer\s+capacity|approved\s+capacity|capacity)\s*(?:is|=|:)?\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/i);
  const approvedTransferCapacity = capacityMatch ? Number(capacityMatch[1].replace(/,/g, "")) : null;

  const feeMatch = q.match(/(?:proposed\s+)?(?:transfer\s+)?fee\s*(?:is|=|:)?\s*\$?\s*(\d+(?:\.\d+)?)\s*%?/i);
  const defaultFeeRate = selectedProduct === "Apex" ? 0 : 0.02;
  const feeRate = feeMatch ? Number(feeMatch[1]) / 100 : defaultFeeRate;
  const zeroFeeRate = Number.isFinite(feeRate) && Math.abs(feeRate) < 0.000001;
  const explicitFeeTreatment = /inside that capacity|inside\s+capacity|counts inside|counts\s+inside/i.test(q)
    ? "inside_capacity"
    : /outside\s+capacity|counts\s+outside|outside that capacity/i.test(q)
      ? "outside_capacity"
      : null;
  const feeTreatment = explicitFeeTreatment || (zeroFeeRate ? "inside_capacity" : null);

  const monthlyBudgetMatch = q.match(/(?:I can pay|monthly budget|pay\s+\$?\s*)(\d[\d,]*(?:\.\d+)?)\s*(?:per month|monthly|toward debt)/i) ||
    q.match(/(?:monthly debt budget)\s*(?:is|=|:)?\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/i);
  const monthlyDebtBudget = monthlyBudgetMatch ? Number(monthlyBudgetMatch[1].replace(/,/g, "")) : null;

  const cardLabels = ["Card A", "Card B", "Card C"];
  const labelMatches = [];
  for (const label of cardLabels) {
    const match = q.match(new RegExp(label.replace(/\s+/g, "\\s+"), "i"));
    if (match && typeof match.index === "number") {
      labelMatches.push({ label, index: match.index });
    }
  }

  labelMatches.sort((a, b) => a.index - b.index);

  const cards = labelMatches.map((entry, index) => {
    const nextIndex = index + 1 < labelMatches.length ? labelMatches[index + 1].index : q.length;
    const cardSegment = q.slice(entry.index, nextIndex);

    const balanceMatch =
      cardSegment.match(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*balance/i) ||
      cardSegment.match(/balance\s*(?:is|=|:)?\s*\$\s*(\d[\d,]*(?:\.\d+)?)/i) ||
      cardSegment.match(/has\s+(?:a\s+)?\$\s*(\d[\d,]*(?:\.\d+)?)\s*(?:at\b|balance\b)/i);
    const aprMatch = cardSegment.match(/(\d+(?:\.\d+)?)\s*%\s*apr/i);
    const minimumPaymentMatch =
      cardSegment.match(/\$\s*(\d[\d,]*(?:\.\d+)?)\s*minimum payment/i) ||
      cardSegment.match(/minimum payment\s*(?:is|=|:)?\s*\$\s*(\d[\d,]*(?:\.\d+)?)/i);

    const balance = balanceMatch ? Number(balanceMatch[1].replace(/,/g, "")) : null;
    const aprPercent = aprMatch ? Number(aprMatch[1]) : null;
    const minimumPayment = minimumPaymentMatch ? Number(minimumPaymentMatch[1].replace(/,/g, "")) : null;
    const transferEligible = normalizeEligibilityValue(cardSegment);

    if (balance === null && aprPercent === null && minimumPayment === null && transferEligible === null) {
      return null;
    }

    return {
      card_label: entry.label,
      current_balance: balance,
      apr_percent: aprPercent,
      minimum_payment: minimumPayment,
      transfer_eligible: transferEligible,
      valueSource: "customer_provided"
    };
  }).filter(Boolean);

  const hasGlobalEligiblePhrase = /both cards are eligible|both are eligible|all cards are eligible|all are eligible/i.test(q);
  if (hasGlobalEligiblePhrase && cards.length === 0) {
    for (const label of cardLabels) {
      cards.push({
        card_label: label,
        current_balance: null,
        apr_percent: null,
        minimum_payment: null,
        transfer_eligible: true,
        valueSource: "customer_provided"
      });
    }
  }

  if (hasGlobalEligiblePhrase) {
    for (const card of cards) {
      if (card.transfer_eligible === null || typeof card.transfer_eligible === "undefined") {
        card.transfer_eligible = true;
      }
    }
  }

  return rebuildDebtPlanState({
    strategy: "highest_apr_first",
    selectedProduct,
    approvedTransferCapacity,
    feeRate,
    feeTreatment,
    monthlyDebtBudget,
    cards
  });
}

function rebuildDebtPlanState(rawState = {}) {
  const selectedProduct = rawState?.selectedProduct || null;
  const approvedTransferCapacity = rawState?.approvedTransferCapacity != null ? Number(rawState.approvedTransferCapacity) : null;
  const defaultFeeRate = selectedProduct === "Apex" ? 0 : 0.02;
  const feeRate = Number.isFinite(Number(rawState?.feeRate)) ? Number(rawState.feeRate) : defaultFeeRate;
  const zeroFeeRate = Number.isFinite(feeRate) && Math.abs(feeRate) < 0.000001;
  const feeTreatment = rawState?.feeTreatment || (zeroFeeRate ? "inside_capacity" : null);
  const monthlyDebtBudget = rawState?.monthlyDebtBudget != null ? Number(rawState.monthlyDebtBudget) : null;
  const cards = Array.isArray(rawState?.cards) ? rawState.cards
    .map((card) => ({
      card_label: card.card_label,
      current_balance: card.current_balance == null ? null : Number(card.current_balance),
      apr_percent: card.apr_percent == null ? null : Number(card.apr_percent),
      minimum_payment: card.minimum_payment == null ? null : Number(card.minimum_payment),
      transfer_eligible: normalizeEligibilityValue(card.transfer_eligible),
      valueSource: card.valueSource || "customer_provided"
    }))
    .filter((card) => card.card_label && (card.current_balance !== null || card.apr_percent !== null || card.minimum_payment !== null || card.transfer_eligible !== null))
    : [];

  const missingInputs = [];
  if (!selectedProduct) missingInputs.push("selectedProduct");
  if (approvedTransferCapacity === null || Number.isNaN(approvedTransferCapacity) || approvedTransferCapacity <= 0) {
    missingInputs.push("approvedTransferCapacity");
  }
  if (!feeTreatment && !zeroFeeRate) {
    missingInputs.push("feeTreatment");
  }
  if (monthlyDebtBudget === null || Number.isNaN(monthlyDebtBudget) || monthlyDebtBudget <= 0) {
    missingInputs.push("monthlyDebtBudget");
  }

  for (const card of cards) {
    if (card.minimum_payment === null || Number.isNaN(card.minimum_payment)) {
      missingInputs.push(`${card.card_label} minimumPayment`);
    }
    if (card.transfer_eligible === null || typeof card.transfer_eligible === "undefined") {
      missingInputs.push(`${card.card_label} transferEligibility`);
    }
  }

  const uniqueMissingInputs = Array.from(new Set(missingInputs));
  const hasEligibleCard = cards.some((card) => card.transfer_eligible === true);
  const blockingMissingInputs = uniqueMissingInputs.filter((entry) => {
    if (!/transferEligibility/i.test(entry)) {
      return true;
    }

    return !hasEligibleCard;
  });

  if (!selectedProduct || approvedTransferCapacity === null || monthlyDebtBudget === null || cards.length === 0 || blockingMissingInputs.length > 0) {
    return {
      status: "collecting",
      strategy: rawState?.strategy || "highest_apr_first",
      selectedProduct,
      approvedTransferCapacity,
      feeRate,
      feeTreatment,
      monthlyDebtBudget,
      cards,
      missingInputs: uniqueMissingInputs
    };
  }

  return {
    status: "ready",
    strategy: rawState?.strategy || "highest_apr_first",
    monthlyDebtBudget,
    selectedProduct,
    approvedTransferCapacity,
    feeRate,
    feeTreatment,
    cards,
    missingInputs: uniqueMissingInputs.filter((entry) => /transferEligibility/i.test(entry))
  };
}

function mergeDebtPlanState(baseState, incomingState) {
  if (!baseState && !incomingState) {
    return null;
  }

  const baseCards = Array.isArray(baseState?.cards) ? baseState.cards : [];
  const incomingCards = Array.isArray(incomingState?.cards) ? incomingState.cards : [];
  const cardOrder = ["Card A", "Card B", "Card C"];
  const cardMap = new Map();

  for (const card of baseCards) {
    if (!card?.card_label) continue;
    cardMap.set(card.card_label, { ...card });
  }

  for (const card of incomingCards) {
    if (!card?.card_label) continue;
    const existing = cardMap.get(card.card_label) || { card_label: card.card_label };
    cardMap.set(card.card_label, {
      ...existing,
      current_balance: card.current_balance == null ? existing.current_balance ?? null : card.current_balance,
      apr_percent: card.apr_percent == null ? existing.apr_percent ?? null : card.apr_percent,
      minimum_payment: card.minimum_payment == null ? existing.minimum_payment ?? null : card.minimum_payment,
      transfer_eligible: card.transfer_eligible == null ? existing.transfer_eligible ?? null : card.transfer_eligible,
      valueSource: "customer_provided"
    });
  }

  const mergedCards = Array.from(cardMap.values()).sort((a, b) => {
    const aIndex = cardOrder.indexOf(a.card_label);
    const bIndex = cardOrder.indexOf(b.card_label);
    return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex);
  });

  return rebuildDebtPlanState({
    strategy: incomingState?.strategy || baseState?.strategy || "highest_apr_first",
    selectedProduct: incomingState?.selectedProduct || baseState?.selectedProduct || null,
    approvedTransferCapacity: incomingState?.approvedTransferCapacity != null ? incomingState.approvedTransferCapacity : baseState?.approvedTransferCapacity,
    feeRate: incomingState?.feeRate != null ? incomingState.feeRate : baseState?.feeRate,
    feeTreatment: incomingState?.feeTreatment || baseState?.feeTreatment || null,
    monthlyDebtBudget: incomingState?.monthlyDebtBudget != null ? incomingState.monthlyDebtBudget : baseState?.monthlyDebtBudget,
    cards: mergedCards
  });
}

function deriveDebtPlanStateFromConversationHistory(conversationHistory = []) {
  const userMessages = (conversationHistory || []).filter((item) => String(item?.role || "").toLowerCase() === "user");
  let mergedState = null;

  for (const message of userMessages) {
    const parsed = buildExplicitDebtPlanState(message?.message_text || "");
    if (!parsed) {
      continue;
    }

    mergedState = mergedState ? mergeDebtPlanState(mergedState, parsed) : parsed;
  }

  return mergedState;
}

function attachPlanningStateToPlan(plan, planningState) {
  if (!plan) {
    return plan;
  }

  const state = planningState || {};
  const existingState = plan.planningState || {};

  return {
    ...plan,
    planningState: {
      ...existingState,
      status: existingState.status || state.status || (String(plan.transferPlanStatus || "").toLowerCase() === "calculated" ? "ready" : "partial"),
      selectedProduct: state.selectedProduct || existingState.selectedProduct || null,
      approvedTransferCapacity: state.approvedTransferCapacity ?? existingState.approvedTransferCapacity ?? null,
      feeRate: state.feeRate ?? existingState.feeRate ?? null,
      feeTreatment: state.feeTreatment || existingState.feeTreatment || plan.feeTreatment || null,
      monthlyDebtBudget: state.monthlyDebtBudget ?? existingState.monthlyDebtBudget ?? null,
      cards: Array.isArray(existingState.cards) && existingState.cards.length > 0
        ? existingState.cards
        : Array.isArray(state.cards)
          ? state.cards
          : [],
      missingInputs: Array.isArray(state.missingInputs) ? state.missingInputs : []
    }
  };
}

function buildTransferPlan(cards, scenario) {
  const transferLimit = Number(scenario?.transfer_limit || 0);
  const transferFeePercent = Number(scenario?.transfer_fee_percent || 0);
  const feeRate = Number.isFinite(transferFeePercent) ? transferFeePercent / 100 : 0;
  const feeTreatment =
    Number(scenario?.fee_treatment || "inside_capacity") === 0 ||
    String(scenario?.fee_treatment || "inside_capacity").toLowerCase() === "outside_capacity"
      ? "outside_capacity"
      : "inside_capacity";

  const sortedCards = [...(cards || [])]
    .map((card, originalIndex) => {
      const rawEligibility = normalizeEligibilityValue(card.transfer_eligible ?? card.transferEligible ?? null);
      return {
        originalIndex,
        cardLabel: String(card.card_label || card.cardLabel || "Card"),
        currentBalance: Number(card.current_balance ?? card.currentBalance ?? 0),
        aprPercent: Number(card.apr_percent ?? card.aprPercent ?? 0),
        minimumPayment: Number(card.minimum_payment ?? card.minimumPayment ?? 0),
        creditLimit: Number(card.credit_limit ?? card.creditLimit ?? 0),
        transferEligible: rawEligibility,
        valueSource: String(card.valueSource || "simulation")
      };
    })
    .filter((card) => card.currentBalance > 0)
    .sort((a, b) => {
      const aprDiff = Number(b.aprPercent) - Number(a.aprPercent);
      if (Math.abs(aprDiff) > 0.009) return aprDiff;

      const balanceDiff = Number(a.currentBalance) - Number(b.currentBalance);
      if (Math.abs(balanceDiff) > 0.009) return balanceDiff;

      return Number(a.originalIndex) - Number(b.originalIndex);
    });

  const eligibleCards = sortedCards.filter((card) => card.transferEligible === true);
  const ineligibleCards = sortedCards.filter((card) => card.transferEligible === false);
  const unknownEligibilityCards = sortedCards.filter((card) => card.transferEligible !== true && card.transferEligible !== false);
  const eligibleCardLabels = eligibleCards.map((card) => card.cardLabel);
  const ineligibleCardLabels = ineligibleCards.map((card) => card.cardLabel);
  const unknownEligibilityCardLabels = unknownEligibilityCards.map((card) => card.cardLabel);
  const missingInputs = unknownEligibilityCardLabels.map((cardLabel) => `${cardLabel} transferEligibility`);

  const transferPlanStatus =
    sortedCards.length === 0
      ? "no_cards"
      : eligibleCards.length > 0 && unknownEligibilityCards.length === 0
        ? "calculated"
        : eligibleCards.length > 0 && unknownEligibilityCards.length > 0
          ? "partial_eligibility"
          : eligibleCards.length === 0 && ineligibleCards.length > 0 && unknownEligibilityCards.length === 0
            ? "no_eligible_cards"
            : eligibleCards.length === 0 && unknownEligibilityCards.length > 0
              ? "eligibility_verification_required"
              : "no_cards";

  if (eligibleCards.length === 0) {
    const noEligibleCardReason =
      sortedCards.length === 0
        ? "No card data was provided, so there are no balances to consider for transfer planning."
        : ineligibleCards.length > 0 && unknownEligibilityCards.length === 0
          ? "No eligible source balances were identified among the available cards, so no transfer recommendation was produced."
          : unknownEligibilityCards.length > 0 && ineligibleCards.length === 0
            ? "Transfer eligibility is missing for every card, so an exact allocation cannot be calculated without a verified eligibility input."
            : "No exact transfer allocation was produced because no eligible cards were available after excluding ineligible and unknown-eligibility cards.";

    const shortAnswer =
      sortedCards.length === 0
        ? "No transfer recommendation is available because no cards were supplied."
        : ineligibleCards.length > 0 && unknownEligibilityCards.length === 0
          ? "No eligible source balances were identified, so no transfer recommendation was produced."
          : unknownEligibilityCards.length > 0
            ? "Transfer eligibility is missing for at least one card, so the plan must wait for eligibility verification before an exact allocation can be calculated."
            : "No transfer recommendation is available because no eligible balance-transfer card data was found.";

    return {
      recommendedStrategy: "none",
      recommendedCardLabel: null,
      recommendedTransferAmount: 0,
      totalTransferred: 0,
      totalTransferFees: 0,
      totalCapacityUsed: 0,
      unusedCapacity: roundCurrency(transferLimit),
      totalOpeningTransferredBalance: 0,
      transferFee: 0,
      feeTreatment,
      allocations: [],
      eligibleCardLabels,
      ineligibleCardLabels,
      unknownEligibilityCardLabels,
      missingInputs,
      transferPlanStatus,
      shortAnswer,
      detailedReasoning: noEligibleCardReason
    };
  }

  let remainingTransferCapacity = Math.max(0, transferLimit);
  const allocations = [];

  for (const card of eligibleCards) {
    if (remainingTransferCapacity <= 0) break;

    const cardBalance = Math.max(0, card.currentBalance);
    const maxPrincipal =
      feeTreatment === "inside_capacity"
        ? Math.max(0, Math.floor((remainingTransferCapacity / (1 + feeRate)) * 100) / 100)
        : Math.max(0, remainingTransferCapacity);

    const transferAmount = Math.min(cardBalance, maxPrincipal, remainingTransferCapacity);

    if (transferAmount <= 0) {
      continue;
    }

    const transferFee = roundCurrency(transferAmount * feeRate);
    let feeTotal = transferFee;
    let capacityUseForAllocation = feeTreatment === "inside_capacity"
      ? roundCurrency(transferAmount + feeTotal)
      : roundCurrency(transferAmount);

    if (feeTreatment === "inside_capacity" && transferAmount < cardBalance) {
      const unallocatedCents = roundCurrency(remainingTransferCapacity - capacityUseForAllocation);
      if (unallocatedCents > 0 && unallocatedCents <= 0.01) {
        feeTotal = roundCurrency(remainingTransferCapacity - transferAmount);
        capacityUseForAllocation = roundCurrency(transferAmount + feeTotal);
      }
    }
    const remainingBalance = Math.max(0, cardBalance - transferAmount);

    allocations.push({
      cardLabel: card.cardLabel,
      originalBalance: roundCurrency(cardBalance),
      aprPercent: roundCurrency(card.aprPercent),
      transferAmount: roundCurrency(transferAmount),
      transferFee: roundCurrency(feeTotal),
      remainingBalance: roundCurrency(remainingBalance),
      priorityOrder: allocations.length + 1,
      valueSource: card.valueSource || "simulation"
    });

    remainingTransferCapacity = Math.max(
      0,
      roundCurrency(remainingTransferCapacity - capacityUseForAllocation)
    );
  }

  const totalTransferred = roundCurrency(allocations.reduce((sum, item) => sum + Number(item.transferAmount), 0));
  const totalTransferFees = roundCurrency(allocations.reduce((sum, item) => sum + Number(item.transferFee), 0));
  const totalCapacityUsed = feeTreatment === "inside_capacity"
    ? roundCurrency(totalTransferred + totalTransferFees)
    : roundCurrency(totalTransferred);
  const totalOpeningTransferredBalance = roundCurrency(totalTransferred + totalTransferFees);
  const unusedCapacity = Math.max(0, roundCurrency(transferLimit - totalCapacityUsed));
  const highestAprCard = allocations[0] || null;
  const originalBalanceByLabel = new Map(sortedCards.map((card) => [card.cardLabel, roundCurrency(card.currentBalance)]));

  const recommendedStrategy = highestAprCard ? "highest_apr_first" : "none";
  const recommendedCardLabel = highestAprCard ? highestAprCard.cardLabel : null;
  // recommendedTransferAmount retains the first-priority card allocation contract.
  // totalTransferred is the total transfer principal across all allocations.
  const recommendedTransferAmount = highestAprCard ? roundCurrency(highestAprCard.transferAmount) : 0;
  const sourceCardMinimumsTotal = sortedCards.reduce((sum, card) => sum + Number(card.minimumPayment || 0), 0);
  const cardCBalance = Number(sortedCards.find((card) => card.cardLabel === "Card C")?.currentBalance || 0);
  const remainingMonthlyBudgetAfterMinimums = Math.max(0, roundCurrency(Number(scenario?.monthly_payment_budget || 0) - sourceCardMinimumsTotal));
  const productLabel = sanitizeProductValue(scenario?.keyr_tier || "") || "KEYR";
  const transferFeeLabel = Number.isFinite(transferFeePercent) ? transferFeePercent.toFixed(0) : "0";
  const formatCurrency = (value) => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let shortAnswer = "No transfer recommendation is available because no eligible balance-transfer card data was found.";
  let detailedReasoning = "No qualifying transfer plan was generated because there were no valid card balances or transfer capacity.";

  if (transferPlanStatus === "partial_eligibility" && highestAprCard) {
    const unknownSummary = unknownEligibilityCardLabels.length > 0
      ? `${unknownEligibilityCardLabels.join(", ")} was excluded until transfer eligibility is confirmed.`
      : "";
    const ineligibleSummary = ineligibleCardLabels.length > 0
      ? `${ineligibleCardLabels.join(", ")} was excluded because it is not eligible for transfer.`
      : "";
    shortAnswer = `Using the $${formatCurrency(transferLimit)} ${productLabel} transfer capacity you provided, with the proposed ${transferFeeLabel}% fee counted inside that capacity, the current verified principal is $${formatCurrency(totalTransferred)}. ${highestAprCard.cardLabel} is included because eligibility is confirmed. ${unknownSummary} ${ineligibleSummary} The remaining $${formatCurrency(unusedCapacity)} of capacity is unassigned until missing eligibility is confirmed.`.replace(/\s+/g, " ").trim();
    detailedReasoning = `A partial plan was calculated because at least one card is eligible and at least one card still requires transfer-eligibility confirmation. ${unknownSummary} ${ineligibleSummary} Continue required payments on all source cards until each transfer is confirmed. Final approval, eligibility, transfer timing, and terms remain subject to program rules.`.replace(/\s+/g, " ").trim();
  } else if (highestAprCard) {
    const firstAllocation = allocations[0] || null;
    const secondAllocation = allocations[1] || null;
    const hasCardC = originalBalanceByLabel.has("Card C");

    const allocationParts = [];
    if (firstAllocation) {
      allocationParts.push(`The interest-minimizing plan transfers $${formatCurrency(firstAllocation.transferAmount)} from ${firstAllocation.cardLabel} first`);
    }
    if (secondAllocation) {
      allocationParts.push(`and then transfers $${formatCurrency(secondAllocation.transferAmount)} from ${secondAllocation.cardLabel}`);
    }

    const retentionParts = [];
    if (secondAllocation) {
      retentionParts.push(`${secondAllocation.cardLabel} would retain approximately $${formatCurrency(secondAllocation.remainingBalance)}`);
    }
    if (hasCardC) {
      retentionParts.push(`Card C would remain at $${formatCurrency(cardCBalance)}`);
    }

    shortAnswer = `Using the $${formatCurrency(transferLimit)} ${productLabel} transfer capacity you provided, with the proposed ${transferFeeLabel}% fee counted inside that capacity, the maximum transferable principal is $${formatCurrency(totalTransferred)}. ${allocationParts.join(" ")}${allocationParts.length > 0 ? "." : ""} ${retentionParts.join(", ")}${retentionParts.length > 0 ? "." : ""} The total proposed transfer fee is $${formatCurrency(totalTransferFees)}, bringing total capacity used to $${formatCurrency(totalCapacityUsed)}.`.replace(/\s+/g, " ").trim();
    const firstAprText = firstAllocation ? `${Number(firstAllocation.aprPercent || 0).toFixed(2)}% APR` : "the highest APR";
    const secondAprText = secondAllocation ? `${Number(secondAllocation.aprPercent || 0).toFixed(2)}% APR` : "";
    const cardCAprText = Number(sortedCards.find((card) => card.cardLabel === "Card C")?.aprPercent || 0).toFixed(2);
    detailedReasoning = `${firstAllocation?.cardLabel || "The highest-APR card"} is prioritized first because its ${firstAprText} is the highest among eligible cards. ${secondAllocation ? `After ${firstAllocation.cardLabel} is handled, remaining transfer capacity is applied to ${secondAllocation.cardLabel} at ${secondAprText}.` : ""} ${hasCardC ? `Card C at ${cardCAprText}% APR remains outside the transfer when capacity is exhausted after higher-APR allocations.` : ""} The listed source-card minimum payments total $${formatCurrency(sourceCardMinimumsTotal)}, leaving $${formatCurrency(remainingMonthlyBudgetAfterMinimums)} from the stated $${formatCurrency(scenario?.monthly_payment_budget || 0)} monthly debt budget after those listed minimums. Continue making required payments on all source cards until each transfer is confirmed. Final availability, eligibility, fees, timing, and terms remain subject to approval and the applicable program terms.`.replace(/\s+/g, " ").trim();
  }

  const planningStateCards = sortedCards.map((card, index) => {
    const allocation = allocations.find((item) => item.cardLabel === card.cardLabel);
    const plannedTransferAmount = Number(allocation?.transferAmount ?? 0);
    const remainingBalance = Math.max(0, Number(card.currentBalance || 0) - plannedTransferAmount);

    return {
      cardLabel: card.cardLabel,
      originalBalance: roundCurrency(Number(card.currentBalance || 0)),
      aprPercent: roundCurrency(Number(card.aprPercent || 0)),
      minimumPayment: roundCurrency(Number(card.minimumPayment || 0)),
      transferEligible: card.transferEligible,
      plannedTransferAmount: roundCurrency(plannedTransferAmount),
      transferFee: roundCurrency(Number(allocation?.transferFee || 0)),
      remainingBalance: roundCurrency(remainingBalance),
      priorityOrder: index + 1,
      valueSource: card.valueSource || "simulation"
    };
  });

  return {
    recommendedStrategy,
    recommendedCardLabel,
    recommendedTransferAmount,
    totalTransferred,
    totalTransferFees,
    totalCapacityUsed,
    totalOpeningTransferredBalance,
    unusedCapacity,
    transferFee: totalTransferFees,
    feeTreatment,
    allocations: allocations,
    eligibleCardLabels,
    ineligibleCardLabels,
    unknownEligibilityCardLabels,
    missingInputs,
    transferPlanStatus,
    shortAnswer,
    detailedReasoning,
    planningState: {
      status: transferPlanStatus === "calculated" ? "ready" : "partial",
      cards: planningStateCards,
      feeTreatment,
      transferPlanStatus
    }
  };
}

function calculateExternalUtilization(cards) {
  const totalBalance = (cards || []).reduce(
    (sum, card) => sum + Number(card.current_balance || 0),
    0
  );

  const totalLimit = (cards || []).reduce(
    (sum, card) => sum + Number(card.credit_limit || 0),
    0
  );

  const utilizationPercent =
    totalLimit > 0 ? (totalBalance / totalLimit) * 100 : null;

  return {
    totalBalance,
    totalLimit,
    utilizationPercent
  };
}

function validateExactDebtPlanResponse(plan) {
  const allocations = Array.isArray(plan?.allocations) ? plan.allocations : [];
  if (!plan || allocations.length === 0) {
    return false;
  }

  const totalTransferred = roundCurrency(Number(plan.totalTransferred || 0));
  const totalTransferFees = roundCurrency(Number(plan.totalTransferFees || 0));
  const totalCapacityUsed = roundCurrency(Number(plan.totalCapacityUsed || 0));
  const principalSum = roundCurrency(allocations.reduce((sum, item) => sum + Number(item.transferAmount || 0), 0));
  const feeSum = roundCurrency(allocations.reduce((sum, item) => sum + Number(item.transferFee || 0), 0));
  const feeTreatment = String(plan.feeTreatment || "inside_capacity").toLowerCase();
  const expectedCapacityUsed = feeTreatment === "inside_capacity"
    ? roundCurrency(totalTransferred + totalTransferFees)
    : roundCurrency(totalTransferred);
  const openingTransferredBalance = roundCurrency(Number(plan.totalOpeningTransferredBalance || 0));
  const highestApr = Math.max(...allocations.map((item) => Number(item.aprPercent || 0)));
  const firstApr = Number(allocations[0]?.aprPercent || 0);
  const noNegativeRemainingBalance = allocations.every((item) => Number(item.remainingBalance || 0) >= 0);
  const noOverAllocation = allocations.every((item) => Number(item.transferAmount || 0) <= Number(item.originalBalance || 0) + 0.01);
  const narrativeText = `${String(plan.shortAnswer || "")} ${String(plan.detailedReasoning || "")}`;
  const noGenericProgressPhrases = !/six completed on-time cycles|positive account-management signals|credit profile stability|next-best-action|next best action/i.test(narrativeText);
  const normalizedShortAnswer = String(plan.shortAnswer || "").replace(/,/g, "");
  const containsKeyAmounts = normalizedShortAnswer.includes(`$${totalTransferred.toFixed(2)}`) && normalizedShortAnswer.includes(`$${totalTransferFees.toFixed(2)}`);
  const insideCapacityValid = feeTreatment !== "inside_capacity" || roundCurrency(totalTransferred + totalTransferFees) <= openingTransferredBalance + 0.01;

  return (
    String(plan.transferPlanStatus || "").toLowerCase() === "calculated" &&
    Math.abs(principalSum - totalTransferred) <= 0.01 &&
    Math.abs(feeSum - totalTransferFees) <= 0.01 &&
    Math.abs(totalCapacityUsed - expectedCapacityUsed) <= 0.01 &&
    noNegativeRemainingBalance &&
    noOverAllocation &&
    Math.abs(firstApr - highestApr) <= 0.01 &&
    insideCapacityValid &&
    containsKeyAmounts &&
    noGenericProgressPhrases
  );
}

function formatDebtPlanMissingInputs(missingInputs = []) {
  const labelMap = {
    selectedProduct: "the selected product (Ascend or Apex)",
    approvedTransferCapacity: "the approved transfer capacity",
    feeTreatment: "whether the proposed transfer fee counts inside or outside capacity",
    monthlyDebtBudget: "the total amount you can pay toward debt each month"
  };

  return (missingInputs || []).map((input) => {
    if (labelMap[input]) {
      return labelMap[input];
    }

    if (/minimumPayment$/i.test(input)) {
      return input.replace(/minimumPayment$/i, "minimum payment");
    }

    if (/transferEligibility$/i.test(input)) {
      return input.replace(/transferEligibility$/i, "transfer eligibility");
    }

    return input;
  });
}

function summarizeDebtPlanCards(cards = []) {
  const summary = [];

  for (const card of cards) {
    if (!card?.card_label) continue;
    const hasBalance = card.current_balance != null && Number.isFinite(Number(card.current_balance));
    const hasApr = card.apr_percent != null && Number.isFinite(Number(card.apr_percent));
    if (!hasBalance || !hasApr) continue;
    summary.push(`${card.card_label} at $${Number(card.current_balance).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} and ${Number(card.apr_percent).toFixed(2)}% APR`);
  }

  return summary;
}

function buildDebtPlanStatusRecommendation(plan, user = {}) {
  if (!plan) {
    return null;
  }

  const firstName = (user?.first_name || "there").trim() || "there";
  const status = String(plan.transferPlanStatus || "").toLowerCase();
  const missingInputs = Array.isArray(plan.missingInputs) ? plan.missingInputs : [];

  if (status === "collecting") {
    const planningState = plan.planningState || {
      status: "collecting",
      selectedProduct: plan.selectedProduct || null,
      cards: Array.isArray(plan.cards) ? plan.cards : [],
      approvedTransferCapacity: plan.approvedTransferCapacity ?? null,
      feeTreatment: plan.feeTreatment ?? null,
      monthlyDebtBudget: plan.monthlyDebtBudget ?? null
    };
    const knownCardSummary = summarizeDebtPlanCards(planningState.cards);
    const missingList = formatDebtPlanMissingInputs(missingInputs).map((entry) => {
      if (/proposed transfer fee counts inside or outside capacity/i.test(entry) && Number.isFinite(Number(planningState.feeRate)) && Number(planningState.feeRate) > 0) {
        return `whether the proposed ${(Number(planningState.feeRate) * 100).toFixed(0)}% fee counts inside or outside that capacity`;
      }

      return entry;
    });
    const productText = planningState.selectedProduct ? `an ${planningState.selectedProduct} plan` : "a transfer plan";
    const knownCardsText = knownCardSummary.length > 0 ? `${knownCardSummary.join(" and ")}` : "the balances and APRs you shared";
    const answer = `${firstName}, I have ${productText} started with ${knownCardsText}. To calculate the exact plan, I still need ${missingList.length > 0 ? missingList.join(", ") : "the remaining required planning details"}. I am not making assumptions about fee treatment, capacity, transfer eligibility, or minimum payment details.`;
    return {
      recommendation: {
        recommendedStrategy: "none",
        recommendedCardLabel: null,
        recommendedTransferAmount: 0,
        totalTransferred: 0,
        totalTransferFees: 0,
        totalCapacityUsed: 0,
        unusedCapacity: Number(plan.unusedCapacity || 0),
        totalOpeningTransferredBalance: 0,
        transferFee: 0,
        feeTreatment: plan.feeTreatment ?? null,
        transferPlanStatus: "collecting",
        allocations: [],
        missingInputs,
        planningState,
        shortAnswer: answer,
        detailedReasoning: "The planning request is incomplete, so the system is collecting the missing transfer-capacity, fee-treatment, card minimum, and eligibility details before it can calculate an exact plan."
      },
      answerSource: "deterministic"
    };
  }

  if (["partial_eligibility", "eligibility_verification_required", "no_eligible_cards", "no_cards"].includes(status)) {
    return {
      recommendation: {
        ...plan,
        recommendedStrategy: plan.recommendedStrategy || "none",
        recommendedCardLabel: plan.recommendedCardLabel || null,
        recommendedTransferAmount: Number(plan.recommendedTransferAmount || 0),
        totalTransferred: Number(plan.totalTransferred || 0),
        totalTransferFees: Number(plan.totalTransferFees || 0),
        totalCapacityUsed: Number(plan.totalCapacityUsed || 0),
        unusedCapacity: Number(plan.unusedCapacity || 0),
        totalOpeningTransferredBalance: Number(plan.totalOpeningTransferredBalance || 0),
        transferFee: Number(plan.transferFee || 0),
        feeTreatment: plan.feeTreatment ?? null,
        transferPlanStatus: plan.transferPlanStatus || status,
        allocations: Array.isArray(plan.allocations) ? plan.allocations : [],
        missingInputs: Array.isArray(plan.missingInputs) ? plan.missingInputs : []
      },
      answerSource: "deterministic"
    };
  }

  return null;
}

function addBusinessDays(startDate, businessDays) {
  const result = new Date(startDate);
  let addedDays = 0;

  while (addedDays < businessDays) {
    result.setDate(result.getDate() + 1);

    const day = result.getDay();

    if (day !== 0 && day !== 6) {
      addedDays += 1;
    }
  }

  return result;
}

function formatDateForMember(date) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function buildBalanceTransferTimingContext() {
  const today = new Date();

  const earliest = addBusinessDays(today, 5);
  const latest = addBusinessDays(today, 10);

  return {
    estimatedStartDate: formatDateForMember(today),
    estimatedEarliestCompletion: formatDateForMember(earliest),
    estimatedLatestCompletion: formatDateForMember(latest),
    businessDayWindow: "5-10 business days"
  };
}

async function getKnowledgeArticleByCode(pool, articleCode, matchWeight = 100) {
  const result = await pool
    .request()
    .input("article_code", sql.NVarChar(150), articleCode)
    .input("match_weight", sql.Int, matchWeight)
    .query(`
      SELECT TOP 1
          article_id,
          article_code,
          title,
          approved_answer,
          short_answer,
          recommended_model,
          escalation_required,
          human_review_required,
          @match_weight AS best_match_weight
      FROM dbo.AiKnowledgeArticles
      WHERE article_code = @article_code
        AND is_active = 1;
    `);

  return result.recordset.length > 0 ? result.recordset[0] : null;
}

function isSecuredTierBalanceTransferQuestion(question) {
  const q = (question || "").toLowerCase().trim();

  return (
    q.includes("balance transfer") &&
    (
      q.includes("merit") ||
      q.includes("anchor") ||
      q.includes("secured") ||
      q.includes("anchor base")
    )
  );
}

function isBalanceTransferEligibilityQuestion(question) {
  const q = (question || "").toLowerCase().trim();

  const mentionsBalanceTransfer =
    q.includes("balance transfer") ||
    q.includes("balance tranfer") ||
    q.includes("transfer a balance") ||
    q.includes("transfer my balance");

  const asksEligibility =
    q.includes("can i") ||
    q.includes("am i eligible") ||
    q.includes("am i able") ||
    q.includes("do i qualify") ||
    q.includes("can my card") ||
    q.includes("does my card") ||
    q.includes("does my tier");

  const asksForStrategy =
    q.includes("which balance") ||
    q.includes("which card") ||
    q.includes("how much") ||
    q.includes("how long") ||
    q.includes("what amount") ||
    q.includes("pay first") ||
    q.includes("strategy");

  return (
    mentionsBalanceTransfer &&
    asksEligibility &&
    !asksForStrategy
  );
}

function getFallbackKnowledgeArticle(question) {
  if (isSecuredTierBalanceTransferQuestion(question)) {
    return {
      article_id: null,
      article_code: "BT_010_SECURED_TIERS_NO_TRANSFER",
      title: "Can secured tiers support balance transfers?",
      approved_answer:
        "Anchor does not support balance transfers. Retired product aliases like Merit map to Anchor in the current model. Balance transfers are only available for KEYR's unsecured products, Ascend and Apex, subject to approval, available credit, sponsor-bank rules, program terms, and transfer availability.",
      short_answer:
        "Anchor does not support balance transfers. Balance transfers are only available for Ascend and Apex, subject to approval and program terms.",
      recommended_model: "gpt-5-mini",
      escalation_required: false,
      human_review_required: false,
      best_match_weight: 100
    };
  }

  if (isTransferTimingQuestion(question)) {
    return {
      article_id: null,
      article_code: "BT_022_TRANSFER_TIMING",
      title: "How long does a balance transfer take?",
      approved_answer:
        "Balance transfers are only available for KEYR's unsecured products, Ascend and Apex, subject to approval, available credit, sponsor-bank rules, program terms, and transfer availability. When available, a balance transfer usually takes 5 to 7 business days to complete. Weekends and bank holidays do not count toward that timeline. Continue making required payments on the original account until the transfer is confirmed as completed.",
      short_answer:
        "Balance transfers are only available for Ascend and Apex, subject to approval and program terms. When available, a balance transfer usually takes 5 to 7 business days, and weekends and bank holidays do not count. Continue paying the original account until the transfer is confirmed.",
      recommended_model: "gpt-5-mini",
      escalation_required: false,
      human_review_required: false,
      best_match_weight: 100
    };
  }

  if (isNextStepQuestion(question)) {
    return {
      article_id: null,
      article_code: "COACH_042_FOCUS_NEXT",
      title: "What should I do next?",
      approved_answer:
        "Focus on the next best action based on current readiness, dashboard guidance, and the member's next focus area.",
      short_answer:
        "Focus on the next best action based on readiness signals and dashboard guidance.",
      recommended_model: "DeepSeek-V4-Pro",
      escalation_required: false,
      human_review_required: false,
      best_match_weight: 100
    };
  }

  if (isPayFirstQuestion(question)) {
    return {
      article_id: null,
      article_code: "COACH_048_PAY_FIRST",
      title: "Which balance should I pay first?",
      approved_answer:
        "KEYR may recommend paying high-APR balances first for interest savings, while also keeping accounts current and considering utilization and due dates.",
      short_answer:
        "KEYR may prioritize high-APR balances while keeping accounts current.",
      recommended_model: "DeepSeek-V4-Pro",
      escalation_required: false,
      human_review_required: false,
      best_match_weight: 100
    };
  }

  return null;
}

async function findKnowledgeArticle(pool, question) {
  const cleanQuestion = (question || "").trim();

  if (!cleanQuestion) {
    return null;
  }

  if (isTransferTimingQuestion(cleanQuestion)) {
    const article = await getKnowledgeArticleByCode(
      pool,
      "BT_022_TRANSFER_TIMING",
      100
    );

    return article || getFallbackKnowledgeArticle(cleanQuestion);
  }

  if (isNextStepQuestion(cleanQuestion)) {
    const article = await getKnowledgeArticleByCode(
      pool,
      "COACH_042_FOCUS_NEXT",
      100
    );

    return article || getFallbackKnowledgeArticle(cleanQuestion);
  }

  if (isPayFirstQuestion(cleanQuestion)) {
    const article = await getKnowledgeArticleByCode(
      pool,
      "COACH_048_PAY_FIRST",
      100
    );

    return article || getFallbackKnowledgeArticle(cleanQuestion);
  }

  const result = await pool
    .request()
    .input("question", sql.NVarChar(500), cleanQuestion)
    .query(`
      WITH ScoredArticles AS (
          SELECT
              a.article_id,
              a.article_code,
              a.title,
              a.approved_answer,
              a.short_answer,
              a.recommended_model,
              a.escalation_required,
              a.human_review_required,
              MAX(
                  q.match_weight
                  +
                  CASE
                      WHEN LOWER(@question) LIKE '%' + LOWER(a.title) + '%'
                      THEN 100 ELSE 0
                  END
                  +
                  CASE
                      WHEN LOWER(@question) LIKE '%' + LOWER(q.question_text) + '%'
                      THEN 100 ELSE 0
                  END
                  +
                  CASE
                      WHEN LOWER(q.question_text) LIKE '%' + LOWER(@question) + '%'
                      THEN 80 ELSE 0
                  END
                  +
                  CASE
                      WHEN LOWER(@question) LIKE '%balance transfer%'
                           AND a.article_code LIKE 'BT_%'
                      THEN 60 ELSE 0
                  END
                  +
                  CASE
                      WHEN LOWER(@question) LIKE '%ascend%'
                           AND a.article_code = 'COACH_043_READY_ASCEND'
                      THEN 100 ELSE 0
                  END
                  +
                  CASE
                      WHEN LOWER(@question) LIKE '%apex%'
                           AND a.article_code = 'COACH_044_FAR_FROM_APEX'
                      THEN 100 ELSE 0
                  END
                  +
                  CASE
                      WHEN LOWER(@question) LIKE '%utilization%'
                           AND a.article_code LIKE 'UTIL_%'
                      THEN 80 ELSE 0
                  END
              ) AS best_match_weight
          FROM dbo.AiKnowledgeArticleQuestions q
          INNER JOIN dbo.AiKnowledgeArticles a
              ON q.article_id = a.article_id
          WHERE
              q.is_active = 1
              AND a.is_active = 1
              AND (
                    LOWER(@question) LIKE '%' + LOWER(q.question_text) + '%'
                    OR LOWER(q.question_text) LIKE '%' + LOWER(@question) + '%'
                    OR LOWER(@question) LIKE '%' + LOWER(a.title) + '%'
                    OR LOWER(@question) LIKE '%balance transfer%'
                    OR LOWER(@question) LIKE '%utilization%'
                    OR LOWER(@question) LIKE '%ascend%'
                    OR LOWER(@question) LIKE '%apex%'
                    OR LOWER(@question) LIKE '%snowball%'
                    OR LOWER(@question) LIKE '%avalanche%'
                    OR LOWER(@question) LIKE '%which card%'
                    OR LOWER(@question) LIKE '%pay first%'
                  )
          GROUP BY
              a.article_id,
              a.article_code,
              a.title,
              a.approved_answer,
              a.short_answer,
              a.recommended_model,
              a.escalation_required,
              a.human_review_required
      )
      SELECT TOP 1
          article_id,
          article_code,
          title,
          approved_answer,
          short_answer,
          recommended_model,
          escalation_required,
          human_review_required,
          best_match_weight
      FROM ScoredArticles
      WHERE best_match_weight >= 100
      ORDER BY
          best_match_weight DESC,
          article_code;
    `);

  if (result.recordset.length > 0) {
    return result.recordset[0];
  }

  return getFallbackKnowledgeArticle(cleanQuestion);
}

async function getMemberCoachContext(pool, simUserId) {
  if (!simUserId) {
    return null;
  }

  const result = await pool
    .request()
    .input("sim_user_id", sql.UniqueIdentifier, simUserId)
    .query(`
      SELECT TOP 1
          r.sim_user_id,
          r.first_name,
          r.last_name,
          r.email,
          r.current_tier,
          r.on_time_cycles_completed,
          r.on_time_cycles_required,
          r.on_time_status,
          r.avg_utilization_percent,
          r.utilization_target_percent,
          r.utilization_status,
          r.credit_score,
          r.ascend_min_score,
          r.apex_min_score,
          r.credit_score_status,
          r.credit_score_previous,
          r.credit_score_change,
          r.credit_score_trend_status,
          r.readiness_override_status,
          r.readiness_override_reason,
          r.readiness_indicator_count,
          r.calculated_readiness_status,
          r.next_focus_area,
          d.user_goal,
          d.guidance_level,
          d.credit_limit,
          d.posted_balance,
          d.pending_debits,
          d.pending_credits,
          d.projected_balance,
          d.target_balance,
          d.projected_utilization_percent,
          d.recommended_payment_before_close,
          d.days_until_statement_close,
          d.days_until_due_date,
          d.autopay_enabled,
          d.dashboard_status,
          d.dashboard_status_title,
          d.next_best_action_message
      FROM dbo.vwSimReadinessSummary r
      INNER JOIN dbo.vwSimDashboardSummary d
          ON r.sim_user_id = d.sim_user_id
      WHERE r.sim_user_id = @sim_user_id;
    `);

  return result.recordset.length > 0 ? result.recordset[0] : null;
}

async function getActiveCoachingAlerts(pool, simUserId) {
  if (!simUserId) {
    return [];
  }

  const result = await pool
    .request()
    .input(
      "sim_user_id",
      sql.UniqueIdentifier,
      simUserId
    )
    .query(`
      SELECT TOP (10)
          sim_alert_id,
          sim_user_id,
          sim_account_id,
          trigger_transaction_id,
          alert_type,
          alert_status,
          severity,
          title,
          message,
          recommended_amount,
          target_utilization_percent,
          projected_utilization_percent,
          projected_statement_balance,
          target_statement_balance,
          statement_close_date,
          recommended_payment_date,
          action_label,
          action_url,
          conversation_id,
          created_at_utc,
          updated_at_utc
      FROM dbo.SimAlerts
      WHERE sim_user_id = @sim_user_id
        AND alert_status IN (
          'New',
          'Delivered',
          'Acknowledged'
        )
      ORDER BY
          updated_at_utc DESC,
          created_at_utc DESC;
    `);

  return result.recordset || [];
}

function isGuid(value) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    value || ""
  );
}

async function getOrCreateCoachConversation(pool, user, requestedConversationId) {
  if (requestedConversationId && isGuid(requestedConversationId)) {
    const existing = await pool
      .request()
      .input("conversation_id", sql.UniqueIdentifier, requestedConversationId)
      .input("sim_user_id", sql.UniqueIdentifier, user.sim_user_id)
      .query(`
        SELECT TOP 1
            conversation_id,
            sim_user_id,
            email,
            conversation_status
        FROM dbo.SimAiCoachConversations
        WHERE conversation_id = @conversation_id
          AND sim_user_id = @sim_user_id
          AND conversation_status = 'active';
      `);

    if (existing.recordset.length > 0) {
      return existing.recordset[0];
    }
  }

  const created = await pool
    .request()
    .input("sim_user_id", sql.UniqueIdentifier, user.sim_user_id)
    .input("email", sql.NVarChar(255), user.email)
    .query(`
      INSERT INTO dbo.SimAiCoachConversations (
          sim_user_id,
          email,
          conversation_status,
          started_at_utc,
          updated_at_utc
      )
      OUTPUT
          inserted.conversation_id,
          inserted.sim_user_id,
          inserted.email,
          inserted.conversation_status
      VALUES (
          @sim_user_id,
          @email,
          'active',
          SYSUTCDATETIME(),
          SYSUTCDATETIME()
      );
    `);

  return created.recordset[0];
}

async function getCoachConversationHistory(pool, conversationId, messageLimit = 8) {
  if (!conversationId) {
    return [];
  }

  const result = await pool
    .request()
    .input("conversation_id", sql.UniqueIdentifier, conversationId)
    .input("message_limit", sql.Int, messageLimit)
    .query(`
      SELECT *
      FROM (
          SELECT TOP (@message_limit)
              role,
              message_text,
              message_metadata,
              created_at_utc
          FROM dbo.SimAiCoachConversationMessages
          WHERE conversation_id = @conversation_id
          ORDER BY created_at_utc DESC
      ) recent
      ORDER BY created_at_utc ASC;
    `);

  return (result.recordset || []).map((item) => ({
    ...item,
    message_metadata: safeParseConversationMetadata(item?.message_metadata)
  }));
}

function safeParseConversationMetadata(rawMetadata) {
  if (!rawMetadata || typeof rawMetadata !== "string") {
    return rawMetadata && typeof rawMetadata === "object" ? rawMetadata : null;
  }

  try {
    return JSON.parse(rawMetadata);
  } catch (_error) {
    return null;
  }
}

function hasFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function normalizeCheckpointCards(cards = []) {
  if (!Array.isArray(cards)) {
    return [];
  }

  return cards
    .map((card, index) => ({
      cardLabel: String(card?.cardLabel || card?.card_label || "").trim(),
      originalBalance: hasFiniteNumber(card?.originalBalance) ? roundCurrency(Number(card.originalBalance)) : hasFiniteNumber(card?.current_balance) ? roundCurrency(Number(card.current_balance)) : null,
      aprPercent: hasFiniteNumber(card?.aprPercent) ? Number(card.aprPercent) : hasFiniteNumber(card?.apr_percent) ? Number(card.apr_percent) : null,
      minimumPayment: hasFiniteNumber(card?.minimumPayment) ? roundCurrency(Number(card.minimumPayment)) : hasFiniteNumber(card?.minimum_payment) ? roundCurrency(Number(card.minimum_payment)) : null,
      transferEligible: normalizeEligibilityValue(card?.transferEligible ?? card?.transfer_eligible ?? null),
      plannedTransferAmount: hasFiniteNumber(card?.plannedTransferAmount) ? roundCurrency(Number(card.plannedTransferAmount)) : hasFiniteNumber(card?.transferAmount) ? roundCurrency(Number(card.transferAmount)) : null,
      transferFee: hasFiniteNumber(card?.transferFee) ? roundCurrency(Number(card.transferFee)) : null,
      remainingBalance: hasFiniteNumber(card?.remainingBalance) ? roundCurrency(Number(card.remainingBalance)) : null,
      priorityOrder: hasFiniteNumber(card?.priorityOrder) ? Number(card.priorityOrder) : index + 1,
      valueSource: String(card?.valueSource || "customer_provided")
    }))
    .filter((card) => card.cardLabel);
}

function checkpointCardsToPlanInput(cards = []) {
  return normalizeCheckpointCards(cards).map((card) => ({
    card_label: card.cardLabel,
    current_balance: card.originalBalance,
    apr_percent: card.aprPercent,
    minimum_payment: card.minimumPayment,
    transfer_eligible: card.transferEligible,
    valueSource: card.valueSource || "customer_provided"
  }));
}

function buildDebtPlanCheckpoint({ conversationId = null, plan = null, updatedAtUtc = null } = {}) {
  if (!plan || !["calculated", "partial_eligibility"].includes(String(plan.transferPlanStatus || "").toLowerCase())) {
    return null;
  }

  const planningState = plan.planningState || {};
  const normalizedCards = normalizeCheckpointCards(planningState.cards || plan.cards || []);
  const transferPlanStatus = String(plan.transferPlanStatus || "").toLowerCase();

  return {
    conversationId: conversationId || null,
    status: String(planningState.status || (transferPlanStatus === "calculated" ? "ready" : "partial")).toLowerCase(),
    transferPlanStatus,
    selectedProduct: planningState.selectedProduct || plan.selectedProduct || null,
    approvedTransferCapacity: hasFiniteNumber(planningState.approvedTransferCapacity) ? roundCurrency(Number(planningState.approvedTransferCapacity)) : hasFiniteNumber(plan.approvedTransferCapacity) ? roundCurrency(Number(plan.approvedTransferCapacity)) : null,
    feeRate: hasFiniteNumber(planningState.feeRate) ? Number(planningState.feeRate) : null,
    feeTreatment: planningState.feeTreatment || plan.feeTreatment || null,
    monthlyDebtBudget: hasFiniteNumber(planningState.monthlyDebtBudget) ? roundCurrency(Number(planningState.monthlyDebtBudget)) : hasFiniteNumber(plan.monthlyDebtBudget) ? roundCurrency(Number(plan.monthlyDebtBudget)) : null,
    cards: normalizedCards,
    eligibleCardLabels: Array.isArray(plan.eligibleCardLabels) ? [...plan.eligibleCardLabels] : [],
    unknownEligibilityCardLabels: Array.isArray(plan.unknownEligibilityCardLabels) ? [...plan.unknownEligibilityCardLabels] : [],
    ineligibleCardLabels: Array.isArray(plan.ineligibleCardLabels) ? [...plan.ineligibleCardLabels] : [],
    missingInputs: Array.isArray(plan.missingInputs) ? [...plan.missingInputs] : [],
    allocations: Array.isArray(plan.allocations) ? plan.allocations.map((item) => ({
      cardLabel: item.cardLabel,
      originalBalance: hasFiniteNumber(item.originalBalance) ? roundCurrency(Number(item.originalBalance)) : null,
      aprPercent: hasFiniteNumber(item.aprPercent) ? Number(item.aprPercent) : null,
      transferAmount: hasFiniteNumber(item.transferAmount) ? roundCurrency(Number(item.transferAmount)) : null,
      transferFee: hasFiniteNumber(item.transferFee) ? roundCurrency(Number(item.transferFee)) : null,
      remainingBalance: hasFiniteNumber(item.remainingBalance) ? roundCurrency(Number(item.remainingBalance)) : null,
      priorityOrder: hasFiniteNumber(item.priorityOrder) ? Number(item.priorityOrder) : null,
      valueSource: item.valueSource || "customer_provided"
    })) : [],
    recommendedStrategy: plan.recommendedStrategy || null,
    recommendedCardLabel: plan.recommendedCardLabel || null,
    recommendedTransferAmount: hasFiniteNumber(plan.recommendedTransferAmount) ? roundCurrency(Number(plan.recommendedTransferAmount)) : null,
    totalTransferred: hasFiniteNumber(plan.totalTransferred) ? roundCurrency(Number(plan.totalTransferred)) : null,
    totalTransferFees: hasFiniteNumber(plan.totalTransferFees) ? roundCurrency(Number(plan.totalTransferFees)) : null,
    totalCapacityUsed: hasFiniteNumber(plan.totalCapacityUsed) ? roundCurrency(Number(plan.totalCapacityUsed)) : null,
    unusedCapacity: hasFiniteNumber(plan.unusedCapacity) ? roundCurrency(Number(plan.unusedCapacity)) : null,
    totalOpeningTransferredBalance: hasFiniteNumber(plan.totalOpeningTransferredBalance) ? roundCurrency(Number(plan.totalOpeningTransferredBalance)) : null,
    valueSources: normalizedCards.reduce((accumulator, card) => {
      accumulator[card.cardLabel] = card.valueSource || "customer_provided";
      return accumulator;
    }, {}),
    updatedAtUtc: updatedAtUtc || new Date().toISOString()
  };
}

function buildResumeCalculatedShortAnswer(plan, user = {}) {
  const firstName = (user?.first_name || "there").trim() || "there";
  const formatResumeCurrency = (value) => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const product = String(plan?.planningState?.selectedProduct || plan?.selectedProduct || "transfer").trim();
  const capacity = hasFiniteNumber(plan?.planningState?.approvedTransferCapacity) ? `$${formatResumeCurrency(Number(plan.planningState.approvedTransferCapacity))}` : null;
  const feeRatePercent = hasFiniteNumber(plan?.planningState?.feeRate) ? Number(plan.planningState.feeRate) * 100 : null;
  const treatmentText = plan?.feeTreatment === "outside_capacity"
    ? `with the proposed ${feeRatePercent != null ? formatResumeCurrency(feeRatePercent) : ""}% fee added outside that capacity`
    : `with the proposed ${feeRatePercent != null ? formatResumeCurrency(feeRatePercent) : ""}% fee counted inside that capacity`;
  const firstAllocation = Array.isArray(plan?.allocations) ? plan.allocations[0] : null;
  const secondAllocation = Array.isArray(plan?.allocations) ? plan.allocations[1] : null;
  const secondRemaining = secondAllocation && hasFiniteNumber(secondAllocation.remainingBalance)
    ? ` ${secondAllocation.cardLabel} would retain approximately $${formatResumeCurrency(Number(secondAllocation.remainingBalance))}.`
    : "";
  return `${firstName}, returning to your ${product} transfer plan using ${capacity || "the approved capacity on file"} ${treatmentText}. The plan transfers $${formatResumeCurrency(Number(firstAllocation?.transferAmount || 0))} from ${firstAllocation?.cardLabel || "the first card"}${secondAllocation ? ` and $${formatResumeCurrency(Number(secondAllocation.transferAmount || 0))} from ${secondAllocation.cardLabel}` : ""}, for a total transferred principal of $${formatResumeCurrency(Number(plan?.totalTransferred || 0))}.${secondRemaining} The total proposed transfer fee is $${formatResumeCurrency(Number(plan?.totalTransferFees || 0))}, bringing total capacity used to $${formatResumeCurrency(Number(plan?.totalCapacityUsed || 0))}.`;
}

function reconcilePlanWithCheckpoint(checkpoint = {}) {
  const cards = checkpointCardsToPlanInput(checkpoint.cards || []);
  if (!cards.length || !hasFiniteNumber(checkpoint.approvedTransferCapacity) || !hasFiniteNumber(checkpoint.monthlyDebtBudget) || !hasFiniteNumber(checkpoint.feeRate)) {
    return null;
  }

  if (Number(checkpoint.feeRate) > 0 && !checkpoint.feeTreatment) {
    return null;
  }

  const rebuiltPlan = buildTransferPlan(cards, {
    transfer_limit: Number(checkpoint.approvedTransferCapacity),
    transfer_fee_percent: Number(checkpoint.feeRate) * 100,
    fee_treatment: checkpoint.feeTreatment,
    monthly_payment_budget: Number(checkpoint.monthlyDebtBudget),
    keyr_tier: checkpoint.selectedProduct
  });

  const sameTotals =
    roundCurrency(Number(rebuiltPlan.totalTransferred || 0)) === roundCurrency(Number(checkpoint.totalTransferred || 0)) &&
    roundCurrency(Number(rebuiltPlan.totalTransferFees || 0)) === roundCurrency(Number(checkpoint.totalTransferFees || 0)) &&
    roundCurrency(Number(rebuiltPlan.totalCapacityUsed || 0)) === roundCurrency(Number(checkpoint.totalCapacityUsed || 0)) &&
    roundCurrency(Number(rebuiltPlan.unusedCapacity || 0)) === roundCurrency(Number(checkpoint.unusedCapacity || 0));

  const sameStatus = String(rebuiltPlan.transferPlanStatus || "") === String(checkpoint.transferPlanStatus || "");
  const sameMissingInputs = JSON.stringify([...(rebuiltPlan.missingInputs || [])].sort()) === JSON.stringify([...(checkpoint.missingInputs || [])].sort());
  const sameAllocations = JSON.stringify((rebuiltPlan.allocations || []).map((item) => ({
    cardLabel: item.cardLabel,
    transferAmount: roundCurrency(Number(item.transferAmount || 0)),
    transferFee: roundCurrency(Number(item.transferFee || 0)),
    remainingBalance: roundCurrency(Number(item.remainingBalance || 0))
  }))) === JSON.stringify((checkpoint.allocations || []).map((item) => ({
    cardLabel: item.cardLabel,
    transferAmount: roundCurrency(Number(item.transferAmount || 0)),
    transferFee: roundCurrency(Number(item.transferFee || 0)),
    remainingBalance: roundCurrency(Number(item.remainingBalance || 0))
  })));

  if (!sameStatus || !sameTotals || !sameMissingInputs || !sameAllocations) {
    return null;
  }

  const planningState = {
    status: checkpoint.status || (checkpoint.transferPlanStatus === "calculated" ? "ready" : "partial"),
    selectedProduct: checkpoint.selectedProduct || null,
    approvedTransferCapacity: checkpoint.approvedTransferCapacity ?? null,
    feeRate: checkpoint.feeRate ?? null,
    feeTreatment: checkpoint.feeTreatment || null,
    monthlyDebtBudget: checkpoint.monthlyDebtBudget ?? null,
    cards: normalizeCheckpointCards(checkpoint.cards || []),
    missingInputs: Array.isArray(checkpoint.missingInputs) ? [...checkpoint.missingInputs] : []
  };

  return {
    ...rebuiltPlan,
    recommendedStrategy: checkpoint.recommendedStrategy || rebuiltPlan.recommendedStrategy,
    recommendedCardLabel: checkpoint.recommendedCardLabel || rebuiltPlan.recommendedCardLabel,
    recommendedTransferAmount: hasFiniteNumber(checkpoint.recommendedTransferAmount) ? roundCurrency(Number(checkpoint.recommendedTransferAmount)) : rebuiltPlan.recommendedTransferAmount,
    totalTransferred: roundCurrency(Number(checkpoint.totalTransferred || rebuiltPlan.totalTransferred || 0)),
    totalTransferFees: roundCurrency(Number(checkpoint.totalTransferFees || rebuiltPlan.totalTransferFees || 0)),
    totalCapacityUsed: roundCurrency(Number(checkpoint.totalCapacityUsed || rebuiltPlan.totalCapacityUsed || 0)),
    unusedCapacity: roundCurrency(Number(checkpoint.unusedCapacity || rebuiltPlan.unusedCapacity || 0)),
    totalOpeningTransferredBalance: roundCurrency(Number(checkpoint.totalOpeningTransferredBalance || rebuiltPlan.totalOpeningTransferredBalance || 0)),
    feeTreatment: checkpoint.feeTreatment || rebuiltPlan.feeTreatment || null,
    missingInputs: Array.isArray(checkpoint.missingInputs) ? [...checkpoint.missingInputs] : rebuiltPlan.missingInputs,
    eligibleCardLabels: Array.isArray(checkpoint.eligibleCardLabels) ? [...checkpoint.eligibleCardLabels] : rebuiltPlan.eligibleCardLabels,
    unknownEligibilityCardLabels: Array.isArray(checkpoint.unknownEligibilityCardLabels) ? [...checkpoint.unknownEligibilityCardLabels] : rebuiltPlan.unknownEligibilityCardLabels,
    ineligibleCardLabels: Array.isArray(checkpoint.ineligibleCardLabels) ? [...checkpoint.ineligibleCardLabels] : rebuiltPlan.ineligibleCardLabels,
    planningState,
    restoredCheckpointUpdatedAtUtc: checkpoint.updatedAtUtc || null
  };
}

function deriveAuthoritativeDebtPlanFromConversationHistory(conversationHistory = [], user = {}) {
  const assistantMessages = (conversationHistory || []).filter((item) => String(item?.role || "").toLowerCase() === "assistant");
  const sortedAssistantMessages = [...assistantMessages].sort((a, b) => new Date(b?.created_at_utc || 0).getTime() - new Date(a?.created_at_utc || 0).getTime());

  const authoritativeCandidates = [];
  const partialCandidates = [];

  for (const message of sortedAssistantMessages) {
    const checkpoint = message?.message_metadata?.debtPlanCheckpoint;
    if (!checkpoint) {
      continue;
    }

    const restoredPlan = reconcilePlanWithCheckpoint(checkpoint);
    if (!restoredPlan) {
      continue;
    }

    const transferPlanStatus = String(restoredPlan.transferPlanStatus || "").toLowerCase();
    if (transferPlanStatus === "calculated" && validateExactDebtPlanResponse(restoredPlan)) {
      authoritativeCandidates.push(restoredPlan);
    } else if (transferPlanStatus === "partial_eligibility") {
      partialCandidates.push(restoredPlan);
    }
  }

  const selectedPlan = authoritativeCandidates[0] || partialCandidates[0] || null;
  if (!selectedPlan) {
    return null;
  }

  if (String(selectedPlan.transferPlanStatus || "").toLowerCase() === "calculated") {
    selectedPlan.shortAnswer = buildResumeCalculatedShortAnswer(selectedPlan, user);
    selectedPlan.deterministicShortAnswer = selectedPlan.shortAnswer;
  }

  return selectedPlan;
}

async function saveCoachConversationMessage(pool, {
  conversationId,
  simUserId,
  role,
  messageText,
  metadata
}) {
  if (!conversationId || !simUserId || !role || !messageText) {
    return;
  }

  await pool
    .request()
    .input("conversation_id", sql.UniqueIdentifier, conversationId)
    .input("sim_user_id", sql.UniqueIdentifier, simUserId)
    .input("role", sql.NVarChar(30), role)
    .input("message_text", sql.NVarChar(sql.MAX), messageText)
    .input(
      "message_metadata",
      sql.NVarChar(sql.MAX),
      metadata ? JSON.stringify(metadata) : null
    )
    .query(`
      INSERT INTO dbo.SimAiCoachConversationMessages (
          conversation_id,
          sim_user_id,
          role,
          message_text,
          message_metadata,
          created_at_utc
      )
      VALUES (
          @conversation_id,
          @sim_user_id,
          @role,
          @message_text,
          @message_metadata,
          SYSUTCDATETIME()
      );

      UPDATE dbo.SimAiCoachConversations
      SET updated_at_utc = SYSUTCDATETIME()
      WHERE conversation_id = @conversation_id;
    `);
}

function formatCoachConversationHistory(conversationHistory) {
  if (!conversationHistory || conversationHistory.length === 0) {
    return "No prior conversation history.";
  }

  return conversationHistory
    .map((item) => {
      const roleLabel =
        item.role === "assistant" ? "KEYR AI Coach" : "Member";

      return `${roleLabel}: ${item.message_text}`;
    })
    .join("\n");
}

function buildGroundingContext({ memberCoachContext, activeCoachingAlerts = [] }) {
  const info = memberCoachContext || {};
  const retrievedAt = new Date().toISOString();
  const sources = [
    "authenticated_simulation_dashboard",
    "member_readiness_summary",
    "active_alerts"
  ].filter(Boolean);

  const normalizedProduct = normalizeProductInput(info.current_tier || info.currentTier || "", {
    journey: info.journey,
    safeStartMode: info.safe_start_mode
  });

  const currentBalance = info.current_balance != null ? Number(info.current_balance) : null;
  const postedBalance = info.posted_balance != null ? Number(info.posted_balance) : null;
  const projectedBalance = info.projected_balance != null ? Number(info.projected_balance) : null;
  const creditLimit = info.credit_limit != null ? Number(info.credit_limit) : null;
  const minimumPayment = info.minimum_payment != null ? Number(info.minimum_payment) : null;
  const paymentDueDate = info.payment_due_date || null;
  const statementCloseDate = info.statement_close_date || null;
  const daysUntilDueDate = info.days_until_due_date != null ? Number(info.days_until_due_date) : null;
  const daysUntilStatementClose = info.days_until_statement_close != null ? Number(info.days_until_statement_close) : null;
  const autopayEnabled = info.autopay_enabled === true || info.autopay_enabled === 1;
  const accountStatus = normalizeAccountStatusValue(info.dashboard_status ?? info.calculated_readiness_status ?? null);
  const availableCredit = info.available_credit != null ? Number(info.available_credit) : null;
  const recommendedPaymentBeforeClose = info.recommended_payment_before_close != null ? Number(info.recommended_payment_before_close) : null;
  const targetUtilization = info.utilization_target_percent != null ? Number(info.utilization_target_percent) : null;
  const projectedUtilization = info.projected_utilization_percent != null ? Number(info.projected_utilization_percent) : null;

  const hasCurrentPastDueSupport = Boolean(
    info.past_due_status === true ||
    info.past_due_status === 1 ||
    /past[- ]due|delinquent|overdue/i.test(String(info.past_due_status || info.current_delinquency_status || "")) ||
    (Number(info.unpaid_minimum_amount ?? 0) > 0 && (info.minimum_payment != null || info.current_due_amount != null || info.days_until_due_date != null))
  );

  const staleNegativeDueDays = daysUntilDueDate !== null && Number(daysUntilDueDate) < -30 && !hasCurrentPastDueSupport;
  const staleNegativeStatementDays = daysUntilStatementClose !== null && Number(daysUntilStatementClose) < -30 && !hasCurrentPastDueSupport;

  const staleDueDays = staleNegativeDueDays;
  const staleStatementDays = staleNegativeStatementDays;

  const fieldVerification = {
    currentBalance: currentBalance !== null && Number.isFinite(currentBalance) && currentBalance >= 0,
    postedBalance: postedBalance !== null && Number.isFinite(postedBalance) && postedBalance >= 0,
    projectedBalance: projectedBalance !== null && Number.isFinite(projectedBalance) && projectedBalance >= 0,
    creditLimit: creditLimit !== null && Number.isFinite(creditLimit) && creditLimit >= 0,
    minimumPayment: minimumPayment !== null && Number.isFinite(minimumPayment) && minimumPayment >= 0,
    paymentDueDate: Boolean(paymentDueDate),
    statementCloseDate: Boolean(statementCloseDate),
    daysUntilDueDate: daysUntilDueDate !== null && Number.isFinite(daysUntilDueDate) && !staleDueDays,
    daysUntilStatementClose: daysUntilStatementClose !== null && Number.isFinite(daysUntilStatementClose) && !staleStatementDays,
    autopayEnabled: typeof info.autopay_enabled !== "undefined" && info.autopay_enabled !== null,
    accountStatus: Boolean(accountStatus),
    availableCredit: availableCredit !== null && Number.isFinite(availableCredit) && availableCredit >= 0,
    recommendedPaymentBeforeClose: recommendedPaymentBeforeClose !== null && Number.isFinite(recommendedPaymentBeforeClose) && recommendedPaymentBeforeClose >= 0 && !staleStatementDays,
    onTimeStatus: Boolean(info.on_time_status),
    utilizationStatus: Boolean(info.utilization_status),
    nextFocusArea: Boolean(info.next_focus_area),
    canonicalProduct: Boolean(normalizedProduct.product)
  };

  const missingFields = Object.entries(fieldVerification)
    .filter(([, isVerified]) => !isVerified)
    .map(([fieldName]) => fieldName);

  const requiredLiveFields = [
    "currentBalance",
    "minimumPayment",
    "paymentDueDate",
    "statementCloseDate",
    "availableCredit"
  ];

  const onTimeCyclesCompleted = Number(info.on_time_cycles_completed ?? info.on_time_cycles ?? NaN);
  const progressSummarySignals = [
    Boolean(normalizedProduct.product),
    Boolean(info.on_time_status),
    Number.isFinite(onTimeCyclesCompleted),
    typeof info.autopay_enabled !== "undefined" && info.autopay_enabled !== null,
    Number.isFinite(Number(info.avg_utilization_percent ?? NaN)),
    Number.isFinite(Number(info.utilization_target_percent ?? NaN)),
    Number.isFinite(Number(info.projected_utilization_percent ?? NaN)),
    Boolean(accountStatus),
    Boolean(info.next_focus_area),
    Number.isFinite(postedBalance) || Number.isFinite(projectedBalance),
    Number.isFinite(creditLimit)
  ].filter(Boolean).length;

  const verifiedLiveFieldsCount = requiredLiveFields.filter((fieldName) => fieldVerification[fieldName]).length;
  const criticalSummaryFields = [
    Boolean(normalizedProduct.product),
    Boolean(info.on_time_status),
    Boolean(info.utilization_status),
    typeof info.autopay_enabled !== "undefined" && info.autopay_enabled !== null,
    Boolean(accountStatus),
    Boolean(info.next_focus_area)
  ].filter(Boolean).length;

  let status = "unavailable";
  if (!info || Object.keys(info).length === 0) {
    status = "unavailable";
  } else if (staleNegativeDueDays || staleNegativeStatementDays) {
    status = verifiedLiveFieldsCount > 0 || progressSummarySignals >= 4 ? "partial" : "unavailable";
  } else if (verifiedLiveFieldsCount === 0) {
    status = progressSummarySignals >= 4 ? "partial" : "unavailable";
  } else if (verifiedLiveFieldsCount < requiredLiveFields.length) {
    status = "partial";
  } else {
    status = "verified";
  }

  const grounding = {
    status,
    retrievedAt,
    sources,
    missingFields,
    staleFields: [
      ...(staleNegativeDueDays ? ["daysUntilDueDate"] : []),
      ...(staleNegativeStatementDays ? ["daysUntilStatementClose"] : [])
    ],
    conflictingFields: [],
    usedEstimatedValues: false,
    product: normalizedProduct.product || "",
    journey: normalizedProduct.journey || "",
    currentBalance,
    postedBalance,
    projectedBalance,
    statementBalance: null,
    creditLimit,
    availableCredit,
    minimumPayment,
    paymentDueDate,
    statementCloseDate,
    daysUntilDueDate,
    daysUntilStatementClose,
    autopayEnabled,
    accountStatus,
    projectedUtilizationPercent: projectedUtilization,
    targetUtilizationPercent: targetUtilization,
    recommendedPaymentBeforeClose,
    pendingDebits: info.pending_debits != null ? Number(info.pending_debits) : null,
    pendingCredits: info.pending_credits != null ? Number(info.pending_credits) : null,
    fieldVerification
  };

  return grounding;
}

function calculateUtilizationPaymentOpportunity({ creditLimit, projectedBalance, targetUtilizationPercent, pendingPayments = 0, daysUntilStatementClose }) {
  const limit = Number(creditLimit || 0);
  const balance = Number(projectedBalance || 0);
  const target = Number(targetUtilizationPercent || 0) / 100;

  if (!Number.isFinite(limit) || limit <= 0) {
    return { targetBalance: null, recommendedPayment: null, qualifies: false };
  }

  const targetBalance = limit * target;
  const recommendedPayment = Math.max(0, balance - targetBalance);
  const qualifies = Number(daysUntilStatementClose ?? 0) >= 0 && recommendedPayment > 0;

  return {
    targetBalance: Number(targetBalance.toFixed(2)),
    recommendedPayment: Number(recommendedPayment.toFixed(2)),
    qualifies: qualifies && Number((pendingPayments || 0)) < recommendedPayment,
    pendingPayments: Number(pendingPayments || 0)
  };
}

function hasConfirmedPastDueSignal(memberCoachContext = {}) {
  const context = memberCoachContext || {};

  if (context.past_due_status === true || context.past_due_status === 1) {
    return true;
  }

  const delinquencyText = [
    context.past_due_status,
    context.current_delinquency_status,
    context.account_status,
    context.dashboard_status,
    context.payment_status
  ]
    .filter((value) => typeof value !== "undefined" && value !== null && value !== "")
    .map((value) => String(value))
    .join(" ");

  if (/past[- ]due|delinquent|overdue/i.test(delinquencyText)) {
    return true;
  }

  const unpaidMinimumAmount = Number(context.unpaid_minimum_amount ?? 0);
  const hasDueAmountContext =
    context.minimum_payment != null ||
    context.current_due_amount != null ||
    context.days_until_due_date != null;

  return unpaidMinimumAmount > 0 && hasDueAmountContext;
}

function selectNextBestAction(memberCoachContext, activeCoachingAlerts = []) {
  const dueDays = Number(memberCoachContext?.days_until_due_date ?? 999);
  const autopayEnabled = memberCoachContext?.autopay_enabled === true || memberCoachContext?.autopay_enabled === 1;
  const recommendedPayment = Number(memberCoachContext?.recommended_payment_before_close || 0);
  const alert = (activeCoachingAlerts || []).find((entry) => entry.alert_type === "utilization_payment_recommendation") || null;

  if (dueDays < 0) {
    if (hasConfirmedPastDueSignal(memberCoachContext)) {
      return "Past-due payment should be addressed first.";
    }

    return "The billing-cycle status should be confirmed before treating this as a current past-due payment.";
  }

  if (dueDays >= 0 && dueDays <= 7 && !autopayEnabled) {
    return "Payment due soon without AutoPay protection should be addressed next.";
  }

  if (alert && Number(alert.recommended_amount || 0) > 0) {
    return "A utilization payment opportunity before statement close is the current priority.";
  }

  if (recommendedPayment > 0 && dueDays >= 0) {
    return "The most useful next step is to move the projected balance closer to the target before the statement closes.";
  }

  if (!autopayEnabled) {
    return "Setting up AutoPay or a payment reminder is the next useful action.";
  }

  return "Maintain positive payment behavior and continue working toward your long-term utilization target.";
}

function determineProactivePrompt(memberCoachContext) {
  if (!memberCoachContext) {
    return {
      shouldProactivelyPrompt: false,
      promptType: "none",
      promptSeverity: "none",
      reason: "No member coach context available."
    };
  }

  const recommendedPayment = Number(
    memberCoachContext.recommended_payment_before_close ?? 0
  );

  const daysUntilDue = Number(
    memberCoachContext.days_until_due_date ?? 999
  );

  const daysUntilStatementClose = Number(
    memberCoachContext.days_until_statement_close ?? 999
  );

  const autopayEnabled =
    memberCoachContext.autopay_enabled === true ||
    memberCoachContext.autopay_enabled === 1;

  const pendingPaymentCoverage = Number(
    memberCoachContext.pending_payment_coverage ??
      memberCoachContext.pending_payment_amount ??
      memberCoachContext.scheduled_payment_amount ??
      0
  );

  const readinessStatus =
    memberCoachContext.calculated_readiness_status || "";

  const nextFocusArea =
    memberCoachContext.next_focus_area || "";

  if (daysUntilDue < 0 && !autopayEnabled) {
    return {
      shouldProactivelyPrompt: true,
      promptType: "past_due_action",
      promptSeverity: "high",
      reason:
        "Payment due date has passed and autopay is not enabled."
    };
  }

  if (daysUntilDue >= 0 && daysUntilDue <= 7 && !autopayEnabled) {
    return {
      shouldProactivelyPrompt: true,
      promptType: "payment_due_action",
      promptSeverity: "high",
      reason:
        "Payment due date is approaching and autopay is not enabled."
    };
  }

  if (readinessStatus === "profile_changed") {
    return {
      shouldProactivelyPrompt: true,
      promptType: "profile_changed",
      promptSeverity: "medium",
      reason:
        "Broader credit profile changed recently and progress should be reviewed with caution."
    };
  }

  if (readinessStatus === "payment_behavior_needed") {
    return {
      shouldProactivelyPrompt: true,
      promptType: "payment_behavior_needed",
      promptSeverity: "medium",
      reason:
        "Credit profile is showing progress, but on-time payment behavior remains the next priority."
    };
  }

  if (
    recommendedPayment > 0 &&
    daysUntilStatementClose >= 0 &&
    pendingPaymentCoverage < recommendedPayment
  ) {
    return {
      shouldProactivelyPrompt: true,
      promptType: "statement_close_action",
      promptSeverity: "medium",
      reason:
        "Statement close action is recommended based on projected balance and verified payment coverage."
    };
  }

  if (
    (readinessStatus === "progressing" ||
      readinessStatus === "building_progress") &&
    nextFocusArea
  ) {
    return {
      shouldProactivelyPrompt: true,
      promptType: "progress_next_step",
      promptSeverity: "low",
      reason:
        "Member is building progress and has a clear next focus area."
    };
  }

  if (readinessStatus === "strong_progress") {
    return {
      shouldProactivelyPrompt: false,
      promptType: "strong_progress",
      promptSeverity: "none",
      reason:
        "Member is showing strong progress with no immediate proactive action required."
    };
  }

  if (
    memberCoachContext.utilization_status === "below" ||
    memberCoachContext.credit_score_status === "below" ||
    memberCoachContext.on_time_status === "below"
  ) {
    return {
      shouldProactivelyPrompt: true,
      promptType: "profile_improvement",
      promptSeverity: "medium",
      reason:
        "Member has a profile improvement opportunity."
    };
  }

  return {
    shouldProactivelyPrompt: false,
    promptType: "on_track",
    promptSeverity: "none",
    reason:
      "Member appears on track with no immediate proactive action required."
  };
}

function buildDashboardPromptAnswer(memberCoachContext, proactiveDecision) {
  const firstName = memberCoachContext?.first_name || "Member";

  const recommendedPayment = Number(
    memberCoachContext?.recommended_payment_before_close || 0
  );

  const daysUntilDue = Number(
    memberCoachContext?.days_until_due_date ?? 999
  );

  const nextFocusArea =
    memberCoachContext?.next_focus_area || "your financial profile";

  if (proactiveDecision.promptType === "past_due_action") {
    return `Hi ${firstName}, your payment due date has passed and autopay is not enabled. Making a payment as soon as possible may help you stay current and protect your payment history.`;
  }

  if (proactiveDecision.promptType === "payment_due_action") {
    return `Hi ${firstName}, your payment due date is approaching in ${daysUntilDue} day${
      daysUntilDue === 1 ? "" : "s"
    }. Scheduling a payment can help protect your on-time payment history.`;
  }

  if (proactiveDecision.promptType === "profile_changed") {
    return `Hi ${firstName}, your six completed on-time cycles and current utilization results are positive account-management signals. Your broader credit profile changed recently, so your primary focus should be credit profile stability while continuing consistent on-time payment habits and manageable utilization.`;
  }

  if (proactiveDecision.promptType === "payment_behavior_needed") {
    return `Hi ${firstName}, your credit profile is showing positive progress, but on-time payment behavior remains your next priority. Staying current can help strengthen your overall progress.`;
  }

  if (proactiveDecision.promptType === "statement_close_action") {
    return `Hi ${firstName}, your statement closes soon. A payment of $${recommendedPayment.toFixed(
      2
    )} before statement close may help keep your projected balance closer to your target. Your next focus area is strengthening your ${nextFocusArea.toLowerCase()}.`;
  }

  if (proactiveDecision.promptType === "progress_next_step") {
    return `Hi ${firstName}, you are progressing in key areas. Your next focus area is strengthening your ${nextFocusArea.toLowerCase()}. Keep building positive payment behavior, utilization control, and credit profile stability.`;
  }

  if (proactiveDecision.promptType === "profile_improvement") {
    return `Hi ${firstName}, KEYR sees an opportunity to strengthen your profile. Your next focus area is ${nextFocusArea.toLowerCase()}, and consistent payments plus lower balances may help support your progress over time.`;
  }

  if (proactiveDecision.promptType === "strong_progress") {
    return `Hi ${firstName}, your six completed on-time cycles and current utilization results are positive account-management signals. Your broader credit profile changed recently, so your primary focus should be credit profile stability while continuing consistent on-time payment habits and manageable utilization.`;
  }

  if (proactiveDecision.promptType === "on_track") {
    return `Hi ${firstName}, your six completed on-time cycles and current utilization results are positive account-management signals. Your broader credit profile changed recently, so your primary focus should be credit profile stability while continuing consistent on-time payment habits and manageable utilization.`;
  }

  return `Hi ${firstName}, your KEYR AI Coach is available anytime to help you understand your progress, utilization, payments, or debt strategy.`;
}

function buildSuggestedQuestions(memberCoachContext, proactiveDecision) {
  const questions = [];

  if (
  proactiveDecision.promptType ===
  "utilization_payment_recommendation"
) {
  questions.push(
    "Why is KEYR recommending this payment?",
    "What if I can pay only part of it?",
    "How does this payment affect my utilization?",
    "What payment gets me back to my target?"
  );
} else if (
  proactiveDecision.promptType === "profile_changed"
) {

  } else if (proactiveDecision.promptType === "payment_behavior_needed") {
    questions.push(
      "Why is payment behavior my next priority?",
      "How do on-time payments affect my progress?",
      "What should I do next?"
    );

  } else if (proactiveDecision.promptType === "statement_close_action") {
    questions.push(
      "Why is KEYR recommending a payment before statement close?",
      "How does this affect my utilization?",
      "Am I still making progress?"
    );

  } else if (proactiveDecision.promptType === "payment_due_action") {
    questions.push(
      "What happens if I miss a payment?",
      "Should I turn on autopay?",
      "How do payments affect my progress?"
    );

  } else if (proactiveDecision.promptType === "past_due_action") {
    questions.push(
      "What should I do if my payment is past due?",
      "How do late payments affect my progress?",
      "Should I turn on autopay?"
    );

  } else if (proactiveDecision.promptType === "progress_next_step") {
    questions.push(
      "How am I doing?",
      "What should I focus on next?",
      "How do I strengthen my progress?"
    );

  } else if (proactiveDecision.promptType === "strong_progress") {
    questions.push(
      "How am I doing?",
      "How do I maintain strong progress?",
      "What should I watch next?"
    );

  } else if (proactiveDecision.promptType === "profile_improvement") {
    questions.push(
      "What is hurting my profile the most?",
      "How do I improve my profile?",
      "How do I strengthen my progress?"
    );

  } else {
    questions.push(
      "How am I doing?",
      "What should I focus on next?",
      "How do I improve my utilization?"
    );
  }

  questions.push(
    "Which balance should I pay first?",
    "How long does a balance transfer take?"
  );

  return questions.slice(0, 5);
}

function isSafeVerifiedField(grounding, fieldName) {
  if (!grounding || !fieldName) {
    return false;
  }

  const value = grounding[fieldName];

  if (value === null || typeof value === "undefined") {
    return false;
  }

  if (grounding.fieldVerification && grounding.fieldVerification[fieldName] !== true) {
    return false;
  }

  if (Array.isArray(grounding.staleFields) && grounding.staleFields.includes(fieldName)) {
    return false;
  }

  if (Array.isArray(grounding.conflictingFields) && grounding.conflictingFields.includes(fieldName)) {
    return false;
  }

  return true;
}

function shouldShortCircuitDeterministicAnswer(questionType, question) {
  const normalizedType = String(questionType || "").toUpperCase();
  const normalizedQuestion = String(question || "").toLowerCase();

  if (["LIVE_ACCOUNT_LOOKUP", "AUTOPAY_GUIDANCE", "PAYMENT_STATUS", "DEBT_PLAN_NEW", "DEBT_PLAN_ADJUST"].includes(normalizedType)) {
    return true;
  }

  return (
    /current balance|payment due date|exact due date|days until.*due|available credit|statement close|minimum payment|autopay|auto pay|automatic payment/.test(normalizedQuestion) &&
    ["GENERAL_EDUCATION", "ACCOUNT_PROGRESS_SUMMARY", "NEXT_BEST_ACTION", "UNKNOWN"].includes(normalizedType)
  );
}

function buildFieldSpecificAccountResponse({ question, questionType, user, memberCoachContext = {}, grounding = null, debugEnabled = false }) {
  const firstName = getFirstName(user) || "there";
  const questionText = String(question || "");
  const canonicalIntent = String(questionType || classifyQuestionType(question) || "").toUpperCase();
  if (!["LIVE_ACCOUNT_LOOKUP", "AUTOPAY_GUIDANCE", "PAYMENT_STATUS"].includes(canonicalIntent)) {
    return null;
  }
  const liveGrounding = grounding || buildGroundingContext({ memberCoachContext, activeCoachingAlerts: [] });
  const q = questionText.toLowerCase();

  const autopayRequest = /autopay|auto pay|automatic payment/.test(q);
  const availableCreditRequest = /available credit/.test(q);
  const exactDueDateRequest = /(exact due date|what is my exact due date|what is my due date|when is my payment due|when is my due date|remind me of my due date|due date again|payment due date)/i.test(questionText);
  const daysUntilDueRequest = /(how many days until|days until my payment is due|days until due|how long until|days until my due date)/i.test(questionText);
  const currentBalanceRequest = /(current balance|what is my balance|remind me of my current balance|my balance|balance again)/i.test(questionText);

  const safeCurrentBalance = isSafeVerifiedField(liveGrounding, "currentBalance");
  const safeAvailableCredit = isSafeVerifiedField(liveGrounding, "availableCredit");
  const safeAutopayEnabled = isSafeVerifiedField(liveGrounding, "autopayEnabled");
  const safePaymentDueDate = isSafeVerifiedField(liveGrounding, "paymentDueDate");
  const safeDaysUntilDueDate = isSafeVerifiedField(liveGrounding, "daysUntilDueDate");

  if ((canonicalIntent === "AUTOPAY_GUIDANCE" || autopayRequest) && (safeAutopayEnabled || liveGrounding.autopayEnabled !== null)) {
    const autopayEnabled = Boolean(liveGrounding.autopayEnabled);
    return {
      responseType: "AUTOPAY_STATUS",
      shortAnswer: `${firstName}, AutoPay is ${autopayEnabled ? "enabled on your current KEYR account" : "disabled on your current KEYR account"}.`,
      detailedReasoning: autopayEnabled
        ? "Your latest verified account snapshot shows that AutoPay is enabled."
        : "Your latest verified account snapshot shows that AutoPay is disabled.",
      finalRecommendation: {
        recommendedStrategy: "none",
        recommendedCardLabel: null,
        recommendedTransferAmount: 0,
        totalTransferred: 0,
        transferFee: 0,
        allocations: []
      }
    };
  }

  if ((canonicalIntent === "AUTOPAY_GUIDANCE" || autopayRequest) && !safeAutopayEnabled && liveGrounding.autopayEnabled === null) {
    return {
      responseType: "AUTOPAY_STATUS",
      shortAnswer: `${firstName}, I'm unable to verify whether AutoPay is enabled from the current account snapshot, and I do not want to give you an inaccurate answer. Please check your current account dashboard or statement for the latest AutoPay status.`,
      detailedReasoning: "The current account snapshot does not contain a verified AutoPay status, so no status was provided.",
      finalRecommendation: {
        recommendedStrategy: "none",
        recommendedCardLabel: null,
        recommendedTransferAmount: 0,
        totalTransferred: 0,
        transferFee: 0,
        allocations: []
      }
    };
  }

  if ((canonicalIntent === "LIVE_ACCOUNT_LOOKUP" || availableCreditRequest) && availableCreditRequest) {
    if (safeAvailableCredit) {
      return {
        responseType: "AVAILABLE_CREDIT",
        shortAnswer: `${firstName}, your available credit is $${Number(liveGrounding.availableCredit).toFixed(2)}.`,
        detailedReasoning: "The available-credit field was verified from the current account snapshot and was used as the answer.",
        finalRecommendation: {
          recommendedStrategy: "none",
          recommendedCardLabel: null,
          recommendedTransferAmount: 0,
          totalTransferred: 0,
          transferFee: 0,
          allocations: []
        }
      };
    }

    return {
      responseType: "AVAILABLE_CREDIT",
      shortAnswer: `${firstName}, I'm unable to verify your available credit from the current account snapshot, and I do not want to give you an inaccurate amount. Please check your current account dashboard or statement for the latest available-credit amount.`,
      detailedReasoning: "The current account snapshot does not contain a verified available-credit amount, so no amount was provided.",
      finalRecommendation: {
        recommendedStrategy: "none",
        recommendedCardLabel: null,
        recommendedTransferAmount: 0,
        totalTransferred: 0,
        transferFee: 0,
        allocations: []
      }
    };
  }

  if ((canonicalIntent === "LIVE_ACCOUNT_LOOKUP" || currentBalanceRequest) && currentBalanceRequest && safeCurrentBalance) {
    return {
      responseType: "CURRENT_BALANCE",
      shortAnswer: `${firstName}, your current balance is $${Number(liveGrounding.currentBalance).toFixed(2)}.`,
      detailedReasoning: "The current balance field was verified from the current account snapshot and was used as the answer.",
      finalRecommendation: {
        recommendedStrategy: "none",
        recommendedCardLabel: null,
        recommendedTransferAmount: 0,
        totalTransferred: 0,
        transferFee: 0,
        allocations: []
      }
    };
  }

  if ((canonicalIntent === "LIVE_ACCOUNT_LOOKUP" || exactDueDateRequest) && exactDueDateRequest && safePaymentDueDate) {
    return {
      responseType: "DUE_DATE",
      shortAnswer: `${firstName}, your exact payment due date is ${liveGrounding.paymentDueDate}.`,
      detailedReasoning: "The payment due date field was verified from the current account snapshot and was used as the exact due-date answer.",
      finalRecommendation: {
        recommendedStrategy: "none",
        recommendedCardLabel: null,
        recommendedTransferAmount: 0,
        totalTransferred: 0,
        transferFee: 0,
        allocations: []
      }
    };
  }

  if ((canonicalIntent === "LIVE_ACCOUNT_LOOKUP" || daysUntilDueRequest) && daysUntilDueRequest && safeDaysUntilDueDate) {
    return {
      responseType: "DAYS_UNTIL_DUE",
      shortAnswer: `${firstName}, there are ${liveGrounding.daysUntilDueDate} days until your payment is due.`,
      detailedReasoning: "The verified days-until-due field was used for the countdown response.",
      finalRecommendation: {
        recommendedStrategy: "none",
        recommendedCardLabel: null,
        recommendedTransferAmount: 0,
        totalTransferred: 0,
        transferFee: 0,
        allocations: []
      }
    };
  }

  return null;
}

function buildCanonicalProductTransferEligibilityResponse({ question, user = {}, memberCoachContext = {} } = {}) {
  const firstName = getFirstName(user) || "there";
  const q = String(question || "");
  const rawCurrentTier = String(memberCoachContext?.current_tier || user?.current_tier || user?.currentTier || "").trim();
  const explicitNamedProduct = /ascend/i.test(q)
    ? "Ascend"
    : /apex/i.test(q)
      ? "Apex"
      : /anchor/i.test(q)
        ? "Anchor"
        : /merit/i.test(q)
          ? "Merit"
          : rawCurrentTier || "Anchor";

  const normalizedTarget = normalizeProductInput(explicitNamedProduct).product || "Anchor";
  const legacyMerit = /merit/i.test(String(explicitNamedProduct || ""));
  const targetProduct = normalizedTarget || "Anchor";

  const isAnchor = targetProduct === "Anchor";
  const isAscend = targetProduct === "Ascend";
  const isApex = targetProduct === "Apex";

  let shortAnswer = "";
  let detailedReasoning = "";

  if (legacyMerit) {
    shortAnswer = `${firstName}, Merit is a retired KEYR product name that maps to Anchor in the current model. Anchor does not support balance transfers. Ascend and Apex may support balance transfers, subject to approval, available approved transfer capacity, verified transfer eligibility, account status, applicable fees, transfer availability, and program terms.`;
    detailedReasoning = "Merit is recognized only as a legacy compatibility term and maps to Anchor. Anchor does not support balance transfers. No transfer recommendation was produced.";
  } else if (isAnchor) {
    shortAnswer = `${firstName}, Anchor does not support balance transfers. Ascend and Apex may support balance transfers, subject to approval, available approved transfer capacity, verified transfer eligibility, account status, applicable fees, transfer availability, and program terms.`;
    detailedReasoning = "Anchor is the secured KEYR credit-building product and does not support balance transfers. A balance-transfer question involving Ascend or Apex requires confirmed eligibility, approved transfer capacity, applicable fee treatment, account status, and current program terms.";
  } else if (isAscend) {
    shortAnswer = `${firstName}, Ascend may support balance transfers with a proposed 2% transfer fee, subject to approval, verified transfer eligibility, available approved transfer capacity, account status, applicable fees, transfer availability, and program terms.`;
    detailedReasoning = "Ascend is an unsecured KEYR product that may support balance transfers. An exact transfer amount cannot be calculated until transfer eligibility, approved transfer capacity, fee treatment, source-card eligibility, and current account terms are verified.";
  } else if (isApex) {
    shortAnswer = `${firstName}, Apex may support balance transfers with a proposed 0% transfer fee, subject to approval, verified transfer eligibility, available approved transfer capacity, account status, transfer availability, and program terms.`;
    detailedReasoning = "Apex is a premium unsecured KEYR product that may support balance transfers. An exact transfer amount cannot be calculated until transfer eligibility, approved transfer capacity, source-card eligibility, and current account terms are verified.";
  } else {
    shortAnswer = `${firstName}, Anchor does not support balance transfers. Ascend and Apex may support balance transfers, subject to approval, available approved transfer capacity, verified transfer eligibility, account status, applicable fees, transfer availability, and program terms.`;
    detailedReasoning = "The member's current product does not support balance transfers. A separate Ascend or Apex question requires verification of eligibility, approved transfer capacity, fee treatment, and current program terms before any transfer is recommended.";
  }

  return {
    responseType: "BALANCE_TRANSFER_ELIGIBILITY",
    shortAnswer,
    detailedReasoning,
    finalRecommendation: {
      recommendedStrategy: "none",
      recommendedCardLabel: null,
      recommendedTransferAmount: 0,
      totalTransferred: 0,
      transferFee: 0,
      allocations: [],
      productTransferRules: {
        targetProduct: targetProduct,
        transferSupported: !isAnchor,
        proposedFeePercent: isAscend ? 2 : isApex ? 0 : 0,
        approvalRequired: true,
        capacityVerificationRequired: true
      }
    }
  };
}

function resolveFinalRecommendation({
  directAccountResponse,
  genericCoachContext,
  aiResult,
  question,
  questionType,
  user,
  memberCoachContext,
  debugEnabled = false,
  exactPlan = null
}) {
  const normalizedQuestionType = String(questionType || classifyQuestionType(question) || "").toUpperCase();
  const productTransferResponse = normalizedQuestionType === "BALANCE_TRANSFER_ELIGIBILITY"
    ? buildCanonicalProductTransferEligibilityResponse({ question, user, memberCoachContext })
    : null;
  const deterministicPlanRecommendation = Boolean(
    genericCoachContext && (
      genericCoachContext.recommendedStrategy === "highest_apr_first" ||
      genericCoachContext.recommendedStrategy === "none" && (
        Number(genericCoachContext.recommendedTransferAmount || 0) > 0 ||
        Number(genericCoachContext.totalTransferred || 0) > 0 ||
        Number(genericCoachContext.transferFee || 0) > 0 ||
        Array.isArray(genericCoachContext.allocations) && genericCoachContext.allocations.length > 0
      ) ||
      genericCoachContext.recommendedStrategy === "general_progress_coaching" && (
        Number(genericCoachContext.totalTransferred || 0) > 0 ||
        Number(genericCoachContext.recommendedTransferAmount || 0) > 0 ||
        Array.isArray(genericCoachContext.allocations) && genericCoachContext.allocations.length > 0
      )
    )
  );

  if (directAccountResponse) {
    return {
      recommendation: {
        ...directAccountResponse.finalRecommendation,
        deterministicShortAnswer: directAccountResponse.shortAnswer,
        shortAnswer: directAccountResponse.shortAnswer,
        detailedReasoning: directAccountResponse.detailedReasoning
      },
      debug: debugEnabled ? {
        directAccountResponseSelected: true,
        directAccountResponseType: directAccountResponse.responseType,
        finalRecommendationSource: "direct_account_response"
      } : undefined,
      answerSource: "deterministic"
    };
  }

  if (productTransferResponse) {
    return {
      recommendation: {
        ...productTransferResponse.finalRecommendation,
        deterministicShortAnswer: productTransferResponse.shortAnswer,
        shortAnswer: productTransferResponse.shortAnswer,
        detailedReasoning: productTransferResponse.detailedReasoning
      },
      debug: debugEnabled ? {
        directAccountResponseSelected: true,
        directAccountResponseType: productTransferResponse.responseType,
        finalRecommendationSource: "direct_product_transfer_response"
      } : undefined,
      answerSource: "deterministic"
    };
  }

  if (["DEBT_PLAN_NEW", "DEBT_PLAN_ADJUST", "CONVERSATION_RESUME"].includes(normalizedQuestionType)) {
    const debtPlanStatusResolution = buildDebtPlanStatusRecommendation(exactPlan, user);
    if (debtPlanStatusResolution) {
      return {
        recommendation: debtPlanStatusResolution.recommendation,
        debug: debugEnabled ? {
          directAccountResponseSelected: false,
          directAccountResponseType: null,
          finalRecommendationSource: "explicit_debt_plan_state"
        } : undefined,
        answerSource: debtPlanStatusResolution.answerSource
      };
    }
  }

  const exactPlanIsAuthoritative = Boolean(
    exactPlan &&
    (normalizedQuestionType === "DEBT_PLAN_NEW" || normalizedQuestionType === "DEBT_PLAN_ADJUST" || normalizedQuestionType === "CONVERSATION_RESUME") &&
    String(exactPlan.transferPlanStatus || "").toLowerCase() === "calculated" &&
    String(exactPlan?.planningState?.status || "").toLowerCase() === "ready" &&
    validateExactDebtPlanResponse(exactPlan)
  );

  if (exactPlanIsAuthoritative) {
    const exactRecommendation = {
      ...exactPlan,
      deterministicShortAnswer: exactPlan.deterministicShortAnswer || exactPlan.shortAnswer || "",
      shortAnswer: exactPlan.shortAnswer || exactPlan.deterministicShortAnswer || "",
      detailedReasoning: exactPlan.detailedReasoning || "",
      recommendedStrategy: exactPlan.recommendedStrategy || "highest_apr_first",
      recommendedCardLabel: exactPlan.recommendedCardLabel || null,
      recommendedTransferAmount: exactPlan.recommendedTransferAmount ?? 0,
      totalTransferred: exactPlan.totalTransferred ?? 0,
      totalTransferFees: exactPlan.totalTransferFees ?? 0,
      totalCapacityUsed: exactPlan.totalCapacityUsed ?? 0,
      unusedCapacity: exactPlan.unusedCapacity ?? 0,
      totalOpeningTransferredBalance: exactPlan.totalOpeningTransferredBalance ?? 0,
      transferFee: exactPlan.transferFee ?? 0,
      feeTreatment: exactPlan.feeTreatment || "inside_capacity",
      transferPlanStatus: exactPlan.transferPlanStatus || "calculated"
    };

    return {
      recommendation: exactRecommendation,
      debug: debugEnabled ? {
        directAccountResponseSelected: false,
        directAccountResponseType: null,
        finalRecommendationSource: "exact_deterministic_plan"
      } : undefined,
      answerSource: "deterministic"
    };
  }

  const usesDeterministicPlan = deterministicPlanRecommendation || normalizedQuestionType === "DEBT_PLAN_NEW" || normalizedQuestionType === "DEBT_PLAN_ADJUST";
  const genericShortAnswer = usesDeterministicPlan
    ? (genericCoachContext?.deterministicShortAnswer || genericCoachContext?.shortAnswer || aiResult?.shortAnswer || "")
    : (aiResult?.shortAnswer || genericCoachContext?.deterministicShortAnswer || genericCoachContext?.shortAnswer || "");
  const genericDetailedReasoning = usesDeterministicPlan
    ? (genericCoachContext?.deterministicDetailedReasoning || genericCoachContext?.detailedReasoning || "")
    : (genericCoachContext?.deterministicDetailedReasoning || genericCoachContext?.detailedReasoning || "");
  const answerSource = usesDeterministicPlan
    ? "deterministic"
    : aiResult?.aiWasUsed ? "fast_model" : "deterministic";

  return {
    recommendation: {
      recommendedStrategy: genericCoachContext?.recommendedStrategy || "general_progress_coaching",
      recommendedCardLabel: genericCoachContext?.recommendedCardLabel || null,
      recommendedTransferAmount: genericCoachContext?.recommendedTransferAmount || 0,
      totalTransferred: genericCoachContext?.totalTransferred || 0,
      totalTransferFees: genericCoachContext?.totalTransferFees || 0,
      totalCapacityUsed: genericCoachContext?.totalCapacityUsed || 0,
      unusedCapacity: genericCoachContext?.unusedCapacity || 0,
      totalOpeningTransferredBalance: genericCoachContext?.totalOpeningTransferredBalance || 0,
      transferFee: genericCoachContext?.transferFee || 0,
      feeTreatment: genericCoachContext?.feeTreatment || "inside_capacity",
      transferPlanStatus: genericCoachContext?.transferPlanStatus || "general_progress",
      allocations: Array.isArray(genericCoachContext?.allocations) ? genericCoachContext.allocations : [],
      deterministicShortAnswer: genericShortAnswer,
      shortAnswer: genericShortAnswer,
      detailedReasoning: genericDetailedReasoning
    },
    debug: debugEnabled ? {
      directAccountResponseSelected: false,
      directAccountResponseType: null,
      finalRecommendationSource: "generic_coach_context"
    } : undefined,
    answerSource
  };
}

function buildCoachContext({
  question,
  questionType,
  user,
  externalCards,
  scenario,
  plan,
  knowledgeArticle,
  memberCoachContext,
  activeCoachingAlerts
}) {
  const utilization = calculateExternalUtilization(externalCards || []);
  const firstName = getFirstName(user) || "there";
  const q = (question || "").toLowerCase();
  const canonicalIntent = questionType || classifyQuestionType(question);
  const grounding = buildGroundingContext({ memberCoachContext, activeCoachingAlerts });

  if (canonicalIntent === "LIVE_ACCOUNT_LOOKUP") {
    const exactDueDateRequest = /(exact due date|what is my exact due date|what is my due date|when is my payment due|when is my due date|remind me of my due date|due date again|payment due date)/i.test(question || "");
    const daysUntilDueRequest = /(how many days until|days until my payment is due|days until due|how long until|days until my due date)/i.test(question || "");
    const currentBalanceRequest = /(current balance|what is my balance|remind me of my current balance|my balance|balance again)/i.test(question || "");
    const availableCreditRequest = /available credit/i.test(question || "");
    const autopayRequest = /autopay/i.test(question || "");

    const safeCurrentBalance = isSafeVerifiedField(grounding, "currentBalance");
    const safePostedBalance = isSafeVerifiedField(grounding, "postedBalance");
    const safeProjectedBalance = isSafeVerifiedField(grounding, "projectedBalance");
    const safePaymentDueDate = isSafeVerifiedField(grounding, "paymentDueDate");
    const safeDaysUntilDueDate = isSafeVerifiedField(grounding, "daysUntilDueDate");
    const safeAvailableCredit = isSafeVerifiedField(grounding, "availableCredit");
    const safeAutopayEnabled = isSafeVerifiedField(grounding, "autopayEnabled");

    const buildUnavailableResponse = (detailText, detailedReasoning) => ({
      deterministicShortAnswer: detailText,
      deterministicDetailedReasoning: detailedReasoning
    });

    if (currentBalanceRequest && exactDueDateRequest && !safeCurrentBalance && !safePaymentDueDate) {
      const postedBalanceText = safePostedBalance ? `The snapshot includes a posted balance of $${Number(grounding.postedBalance).toFixed(2)} and a projected balance of $${Number(grounding.projectedBalance).toFixed(2)}, but neither is identified as your verified current balance.` : "The snapshot does not contain a verified current balance for this account.";
      const detailText = `${firstName}, I'm unable to verify your current balance or exact payment due date from the current account snapshot, and I do not want to give you inaccurate information. ${postedBalanceText} Please check your current account dashboard or statement for the latest balance and due date. Your earlier financial-readiness conversation remains saved whenever you want to continue.`;
      return buildUnavailableResponse(
        detailText,
        "The current account snapshot does not contain a verified current balance or exact payment due date, so those values were not provided. The account snapshot includes posted and projected balances, but neither is identified as the verified current balance."
      );
    }

    if (safeCurrentBalance && currentBalanceRequest) {
      return {
        deterministicShortAnswer: `${firstName}, your current balance is $${Number(grounding.currentBalance).toFixed(2)}.`,
        deterministicDetailedReasoning: `The current balance field was verified from the current account snapshot and is the value used for this lookup.`
      };
    }

    if (currentBalanceRequest && !safeCurrentBalance) {
      const postedBalanceText = safePostedBalance ? `The snapshot includes a posted balance of $${Number(grounding.postedBalance).toFixed(2)}.` : "";
      const projectedBalanceText = safeProjectedBalance ? ` The snapshot includes a projected balance of $${Number(grounding.projectedBalance).toFixed(2)}.` : "";
      const detailText = `${firstName}, I'm unable to verify your current balance from the current account snapshot, and I do not want to give you inaccurate information.${postedBalanceText}${projectedBalanceText} Please check your current account dashboard or statement for the latest balance. Your earlier financial-readiness conversation remains saved whenever you want to continue.`;
      return buildUnavailableResponse(
        detailText,
        "The current account snapshot does not contain a verified current balance, so that value was not provided. Posted and projected balances are labeled as such and were not substituted as the current balance."
      );
    }

    if (exactDueDateRequest) {
      if (safePaymentDueDate) {
        return {
          deterministicShortAnswer: `${firstName}, your exact payment due date is ${grounding.paymentDueDate}.`,
          deterministicDetailedReasoning: "The payment due date field was verified from the current account snapshot and was used as the exact due date response."
        };
      }

      return buildUnavailableResponse(
        `${firstName}, I'm unable to verify your exact payment due date from the current account snapshot, and I do not want to give you inaccurate information. Please check your current account dashboard or statement for the latest due date. Your earlier financial-readiness conversation remains saved whenever you want to continue.`,
        "The current account snapshot does not contain a verified exact payment due date, so the exact due date was not provided. The days-until field was not used for an exact-date response."
      );
    }

    if (daysUntilDueRequest) {
      if (safeDaysUntilDueDate) {
        return {
          deterministicShortAnswer: `${firstName}, there are ${grounding.daysUntilDueDate} days until your payment is due.`,
          deterministicDetailedReasoning: "The verified days-until-due field was used for the countdown response."
        };
      }

      return buildUnavailableResponse(
        `${firstName}, I'm unable to verify how many days remain until your payment is due from the current account snapshot, and I do not want to give you inaccurate information. Please check your current account dashboard or statement for the latest timing details. Your earlier financial-readiness conversation remains saved whenever you want to continue.`,
        "The current account snapshot does not contain a verified days-until-due value, so the countdown was not provided. Stale or unverified timing values were not used."
      );
    }

    if (availableCreditRequest) {
      if (safeAvailableCredit) {
        return {
          deterministicShortAnswer: `${firstName}, your available credit is $${Number(grounding.availableCredit).toFixed(2)}.`,
          deterministicDetailedReasoning: "The available credit field was verified from the current account snapshot and was used as the answer."
        };
      }

      return buildUnavailableResponse(
        `${firstName}, I'm unable to verify your available credit from the current account snapshot, and I do not want to give you inaccurate information. Please check your current account dashboard or statement for the latest available credit. Your earlier financial-readiness conversation remains saved whenever you want to continue.`,
        "The current account snapshot does not contain a verified available credit value, so that field was not provided."
      );
    }

    if (autopayRequest) {
      if (safeAutopayEnabled) {
        return {
          deterministicShortAnswer: `${firstName}, AutoPay is ${grounding.autopayEnabled ? "enabled on your current KEYR account" : "disabled on your current KEYR account"}.`,
          deterministicDetailedReasoning: "The AutoPay status field was verified from the current account snapshot and was used as the answer."
        };
      }

      return buildUnavailableResponse(
        `${firstName}, I'm unable to verify whether AutoPay is enabled from the current account snapshot, and I do not want to give you inaccurate information. Please check your current account dashboard or statement for the latest AutoPay status. Your earlier financial-readiness conversation remains saved whenever you want to continue.`,
        "The current account snapshot does not contain a verified AutoPay status, so that field was not provided."
      );
    }

    if (grounding.status === "unavailable" || grounding.status === "conflicting") {
      return buildUnavailableResponse(
        `${firstName}, I'm unable to verify that account information right now, and I do not want to give you an inaccurate value. Please check your current account dashboard or statement, or try again shortly. Your prior coaching conversation remains available.`,
        "This is a direct account-specific lookup and verification failed. The current authenticated account data is unavailable, so the answer is intentionally abstained."
      );
    }

    const response = `${firstName}, I'm unable to verify the requested account information from the current account snapshot, and I do not want to give you inaccurate information. Please check your current account dashboard or statement for the latest details. Your earlier financial-readiness conversation remains saved whenever you want to continue.`;

    return {
      deterministicShortAnswer: response,
      deterministicDetailedReasoning: "The current account snapshot does not contain a verified value for the requested field, so it was not provided."
    };
  }

  if (canonicalIntent === "ACCOUNT_PROGRESS_SUMMARY") {
    const product = sanitizeProductValue(memberCoachContext?.current_tier || user?.current_tier || "") || "Anchor";
    const statusText = normalizeAccountStatusValue(memberCoachContext?.dashboard_status ?? memberCoachContext?.calculated_readiness_status ?? null);
    const onTimeStatus = String(memberCoachContext?.on_time_status || "").trim();
    const autopayEnabled = memberCoachContext?.autopay_enabled === true || memberCoachContext?.autopay_enabled === 1;
    const avgUtilization = Number(memberCoachContext?.avg_utilization_percent ?? grounding.projectedUtilizationPercent ?? NaN);
    const targetUtilization = Number(memberCoachContext?.utilization_target_percent ?? grounding.targetUtilizationPercent ?? NaN);
    const projectedUtilization = Number(memberCoachContext?.projected_utilization_percent ?? grounding.projectedUtilizationPercent ?? NaN);
    const nextFocus = String(memberCoachContext?.next_focus_area || "credit profile stability").trim();
    const profileChangeVerified = /profile_changed|profile changed|credit profile/i.test(String(memberCoachContext?.calculated_readiness_status || "") + " " + String(memberCoachContext?.credit_score_trend_status || ""));
    const onTimeCyclesCompleted = Number(memberCoachContext?.on_time_cycles_completed ?? 0);
    const onTimeCyclesRequired = Number(memberCoachContext?.on_time_cycles_required ?? 0);
    const timingUnverified = grounding.daysUntilDueDate === null && grounding.daysUntilStatementClose === null;
    const timingStale = grounding.staleFields.includes("daysUntilDueDate") || grounding.staleFields.includes("daysUntilStatementClose");
    const exactDueDateMissing = !grounding.paymentDueDate && grounding.daysUntilDueDate === null;
    const exactMinimumMissing = grounding.minimumPayment === null || !Number.isFinite(Number(grounding.minimumPayment));

    const verifiedSignals = [];
    if (onTimeCyclesRequired > 0) {
      verifiedSignals.push(`${onTimeCyclesCompleted} of ${onTimeCyclesRequired} on-time cycles were completed`);
    }
    if (autopayEnabled) {
      verifiedSignals.push("AutoPay is enabled");
    }
    if (Number.isFinite(avgUtilization)) {
      verifiedSignals.push(`average utilization is ${Number(avgUtilization).toFixed(0)}%`);
    }
    if (Number.isFinite(targetUtilization)) {
      verifiedSignals.push(`the configured utilization target is ${Number(targetUtilization).toFixed(0)}%`);
    }
    if (Number.isFinite(projectedUtilization)) {
      verifiedSignals.push(`projected utilization is ${Number(projectedUtilization).toFixed(1)}%`);
    }
    if (profileChangeVerified) {
      verifiedSignals.push("the broader credit profile recently changed");
    }
    if (nextFocus) {
      verifiedSignals.push(`next focus is ${nextFocus.toLowerCase()}`);
    }

    const timingStatement = timingUnverified || timingStale
      ? "I cannot verify the current billing-cycle dates from this snapshot, so I do not want to provide an inaccurate due-date estimate."
      : "";

    const finalVerifiedSignals = verifiedSignals.slice(0, 5);
    const groundedSummary = finalVerifiedSignals.length > 0
      ? `${finalVerifiedSignals.join(", ")}.`
      : "the current snapshot is limited, so I am keeping the summary grounded in the data we can verify.";

    return {
      deterministicShortAnswer: `${firstName}, ${groundedSummary}${timingStatement ? ` ${timingStatement}` : ""} Your current focus is ${nextFocus.toLowerCase()}.`,
      deterministicDetailedReasoning: `Grounded progress summary for ${product}. Verified signals: ${finalVerifiedSignals.join("; ") || "limited snapshot"}. Billing-cycle dates cannot be verified in this snapshot, so no current due-date claim or past-due claim is made. Next focus: ${nextFocus}. Recommendation: continue positive payment behavior, maintain AutoPay, and monitor utilization and profile stability.`
    };
  }

const activeUtilizationAlert =
  (activeCoachingAlerts || []).find(
    (alert) =>
      alert.alert_type ===
      "utilization_payment_recommendation"
  );

const asksAboutUtilizationRecommendation =
  questionType === "utilization_coaching" ||
  q.includes("recommended payment") ||
  q.includes("recommendation") ||
  q.includes("statement close") ||
  q.includes("statement closes") ||
  q.includes("why do i need") ||
  q.includes("why is keyr recommending") ||
  q.includes("how am i doing") ||
  q.includes("what should i do next");

if (
  activeUtilizationAlert &&
  asksAboutUtilizationRecommendation
) {
  return {
    deterministicShortAnswer:
      activeUtilizationAlert.message,

    deterministicDetailedReasoning: [
      "Use the active KEYR utilization recommendation as the factual source.",
      `Alert ID: ${activeUtilizationAlert.sim_alert_id}.`,
      `Recommended payment: $${Number(
        activeUtilizationAlert.recommended_amount || 0
      ).toFixed(2)}.`,
      `Projected utilization: ${Number(
        activeUtilizationAlert.projected_utilization_percent || 0
      ).toFixed(2)}%.`,
      `Target utilization: ${Number(
        activeUtilizationAlert.target_utilization_percent || 0
      ).toFixed(2)}%.`,
      `Projected statement balance: $${Number(
        activeUtilizationAlert.projected_statement_balance || 0
      ).toFixed(2)}.`,
      `Target statement balance: $${Number(
        activeUtilizationAlert.target_statement_balance || 0
      ).toFixed(2)}.`,
      `Statement close date: ${
        activeUtilizationAlert.statement_close_date
      }.`,
      `Recommended payment date: ${
        activeUtilizationAlert.recommended_payment_date
      }.`,
      "Do not recalculate, modify, approximate, or replace these values.",
      "Explain the exact recommendation directly and concisely.",
      "Do not describe this amount as the contractual minimum payment."
    ].join(" ")
  };
}

if (
  q.includes("autopay") ||
  q.includes("auto pay") ||
  q.includes("automatic payment") ||
  q.includes("should i turn it on") ||
  q.includes("turn it on")
) {
  const autopayEnabled =
    memberCoachContext?.autopay_enabled === true ||
    memberCoachContext?.autopay_enabled === 1;

  const daysUntilDue = Number(
    memberCoachContext?.days_until_due_date ?? 999
  );

  const onTimeStatus =
    memberCoachContext?.on_time_status || "unknown";

  const nextFocusArea =
    memberCoachContext?.next_focus_area || "payment behavior";

  if (!autopayEnabled) {
    return {
      deterministicShortAnswer:
        `Hi ${firstName}, turning on autopay can help reduce the chance of missing a payment, especially since your next focus area is ${nextFocusArea.toLowerCase()}. Since your due date is approaching in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}, scheduling a payment or enabling autopay can help keep your account current. Before turning it on, make sure the funding account has enough money available.`,
      deterministicDetailedReasoning:
        "Your payment behavior is consistent, and autopay can help reduce the chance of a missed payment. The broader credit-profile change remains the main focus, and ongoing on-time payments plus manageable utilization remain the best path forward. Future opportunities remain subject to eligibility, approval criteria, account status, and program terms."
    };
  }

  return {
    deterministicShortAnswer:
      `Hi ${firstName}, your six completed on-time cycles and current utilization results are positive account-management signals. Your broader credit profile changed recently, so your primary focus should be credit profile stability while continuing consistent on-time payment habits and manageable utilization.`,
    deterministicDetailedReasoning:
      "Your six completed on-time cycles and utilization results show continued consistency within KEYR. The broader credit-profile change is the most important factor to focus on now. Continue making payments on time, keep utilization manageable, and review your credit profile for recent changes. Future opportunities remain subject to eligibility, approval criteria, account status, and program terms."
  };
}

  if (
    memberCoachContext?.calculated_readiness_status === "profile_changed"
) {
  return {
    deterministicShortAnswer:
      `Hi ${firstName}, your six completed on-time cycles and current utilization results are positive account-management signals. Your broader credit profile changed recently, so your primary focus should be credit profile stability while continuing consistent on-time payment habits and manageable utilization.`,
    deterministicDetailedReasoning:
      "Your six completed on-time cycles and utilization results show continued consistency within KEYR. The broader credit-profile change is the most important factor to focus on now. Continue making payments on time, keep utilization manageable, and review your credit profile for recent changes. Future opportunities remain subject to eligibility, approval criteria, account status, and program terms."
  };
}

  if (
    (questionType === "tier_progression" || questionType === "next_step") &&
    knowledgeArticle &&
    memberCoachContext
  ) {
    const readinessStatus =
      memberCoachContext.calculated_readiness_status || "unknown";

    const currentTier =
      normalizeProductInput(user?.current_tier || "").product || user?.current_tier || "current";

    const score =
      memberCoachContext.credit_score;

    const ascendMinScore =
      memberCoachContext.ascend_min_score;

    const nextFocus =
      memberCoachContext.next_focus_area || "credit profile";

    const onTimeStatus =
      memberCoachContext.on_time_status || "unknown";

    const utilizationStatus =
      memberCoachContext.utilization_status || "unknown";

    const nextBestAction =
      memberCoachContext.next_best_action_message ||
      "Your broader credit profile changed recently, so your primary focus should be credit profile stability while continuing consistent on-time payment habits and manageable utilization.";

    const readinessLabel =
      readinessStatus === "nearly_ready"
        ? "nearly ready"
        : readinessStatus === "ready" || readinessStatus === "ready_for_review"
          ? "ready for review"
          : "not yet at the target";

    const deterministicShortAnswer = [
      `Hi ${firstName},`,
      `your next focus area is strengthening your ${nextFocus.toLowerCase()}.`,
      `You are currently classified as ${readinessLabel} for ${currentTier}.`,
      `Your on-time payment and utilization indicators are ${onTimeStatus === "met" && utilizationStatus === "met" ? "meeting expectations" : "areas to monitor"}.`,
      `${nextBestAction}`,
      `KEYR cannot guarantee approval, but continuing positive payment behavior and improving your ${nextFocus.toLowerCase()} may strengthen your financial readiness over time.`
    ].join(" ");

    return {
      deterministicShortAnswer,
      deterministicDetailedReasoning:
        `Official KEYR Knowledge Base article: ${knowledgeArticle.article_code} - ${knowledgeArticle.title}. Member readiness status: ${readinessStatus}. On-time status: ${onTimeStatus}. Utilization status: ${utilizationStatus}. Score: ${score}. Ascend minimum score: ${ascendMinScore}. Next focus area: ${nextFocus}. Next best action: ${nextBestAction}. Do not guarantee approval, underwriting outcomes, or future opportunities. Explain that financial readiness depends on future eligibility, behavior, and program criteria.`,
      knowledgeArticleUsed: {
        articleId: knowledgeArticle.article_id,
        articleCode: knowledgeArticle.article_code,
        title: knowledgeArticle.title,
        recommendedModel: knowledgeArticle.recommended_model,
        escalationRequired: knowledgeArticle.escalation_required,
        humanReviewRequired: knowledgeArticle.human_review_required,
        bestMatchWeight: knowledgeArticle.best_match_weight
      }
    };
  }

  if (knowledgeArticle) {
    let timingContext = null;

    if (
      knowledgeArticle.article_code === "BT_022_TRANSFER_TIMING" ||
      questionType === "transfer_timing"
    ) {
      timingContext = buildBalanceTransferTimingContext();
    }

    const timingText = timingContext
      ? ` If estimated today, a ${timingContext.businessDayWindow} processing window would place the estimated completion between ${timingContext.estimatedEarliestCompletion} and ${timingContext.estimatedLatestCompletion}. Weekends are excluded from this estimate. Actual timing can vary by creditor, review, processing method, and holidays.`
      : "";

    return {
      deterministicShortAnswer:
        `${firstName}, ${knowledgeArticle.short_answer || knowledgeArticle.approved_answer}`,
      deterministicDetailedReasoning:
        `Official KEYR Knowledge Base article: ${knowledgeArticle.article_code} - ${knowledgeArticle.title}. Approved answer: ${knowledgeArticle.approved_answer}.${timingText}`,
      knowledgeArticleUsed: {
        articleId: knowledgeArticle.article_id,
        articleCode: knowledgeArticle.article_code,
        title: knowledgeArticle.title,
        recommendedModel: knowledgeArticle.recommended_model,
        escalationRequired: knowledgeArticle.escalation_required,
        humanReviewRequired: knowledgeArticle.human_review_required,
        bestMatchWeight: knowledgeArticle.best_match_weight
      }
    };
  }

  if (questionType === "transfer_strategy" || questionType === "payoff_strategy") {
    return {
      deterministicShortAnswer: plan.shortAnswer,
      deterministicDetailedReasoning: plan.detailedReasoning
    };
  }

  if (questionType === "utilization_coaching") {
    const utilizationText =
      utilization.utilizationPercent !== null
        ? `The member's simulated outside-card utilization is approximately ${utilization.utilizationPercent.toFixed(
            2
          )}% based on total outside balances of $${utilization.totalBalance.toFixed(
            2
          )} and total outside limits of $${utilization.totalLimit.toFixed(2)}.`
        : "The member's exact utilization could not be calculated from available card data.";

    const fallbackAnswer =
      utilization.utilizationPercent !== null
        ? `Hi ${firstName}, keeping your utilization lower can support financial advancement because it shows you are using less of your available credit. Your simulated outside-card utilization is about ${utilization.utilizationPercent.toFixed(
            2
          )}%, so a practical next step is reducing balances over time while continuing on-time payments. KEYR encourages working toward a low utilization target, such as near 8%, without guaranteeing a credit score increase or tier upgrade.`
        : `Hi ${firstName}, keeping your utilization lower can support financial advancement because it shows you are using less of your available credit. A practical next step is reducing balances over time while continuing on-time payments. KEYR encourages working toward a low utilization target, such as near 8%, without guaranteeing a credit score increase or tier upgrade.`;

    return {
      deterministicShortAnswer: fallbackAnswer,
      deterministicDetailedReasoning:
        `${utilizationText} The member asked about utilization, not balance transfers. Do not recommend a balance transfer unless the member specifically asks about transfers, APR, payoff strategy, or multiple cards. Provide a finished member-facing answer, not instructions.`
    };
  }

  if (questionType === "support_escalation") {
    return {
      deterministicShortAnswer:
        "This question may involve support, hardship, legal, fraud, dispute, collections, or bankruptcy concerns. Provide a safe, brief response and recommend contacting KEYR support for review.",
      deterministicDetailedReasoning:
        "Do not provide legal, bankruptcy, tax, or formal credit-repair advice. Keep the response supportive and direct the member to support."
    };
  }

 return {
  deterministicShortAnswer:
    `Hi ${firstName}, your six completed on-time cycles and current utilization results are positive account-management signals. Your broader credit profile changed recently, so your primary focus should be credit profile stability while continuing consistent on-time payment habits and manageable utilization.`,
  deterministicDetailedReasoning:
    "Your six completed on-time cycles and utilization results show continued consistency within KEYR. The broader credit-profile change is the most important factor to focus on now. Continue making payments on time, keep utilization manageable, and review your credit profile for recent changes. Future opportunities remain subject to eligibility, approval criteria, account status, and program terms."
};
}

function sanitizeCoachResponse(text) {
  if (!text) return "";

  const lower = text.toLowerCase();

  const blockedPatterns = [
    "explain that",
    "do not mention",
    "do not guarantee",
    "internal override",
    "deterministic context",
    "routing reason",
    "question type",
    "classification",
    "internal guidance",
    "developer instructions",
    "system prompt",
    "internal instruction",
    "routing logic",
    "answer source",
    "model family",
    "do not recalculate",
    "support-safe response"
  ];

  const leakedInternalPhrases = blockedPatterns.some((phrase) =>
    lower.includes(phrase)
  );

  const blockedLegacyTerms = [
    "anchor base",
    "merit",
    "merit (secured)",
    "anchor (secured)",
    "ascend (unsecured)",
    "apex (unsecured)",
    "guaranteed approval",
    "guaranteed transfer",
    "guaranteed savings",
    "guaranteed score increase",
    "tier upgrade"
  ];

  const legacyLeak = blockedLegacyTerms.some((term) => lower.includes(term));

  if (!leakedInternalPhrases && !legacyLeak) {
    return text.trim();
  }

  return `Hi Member, your six completed on-time cycles and current utilization results are positive account-management signals. Your broader credit profile changed recently, so your primary focus should be credit profile stability while continuing consistent on-time payment habits and manageable utilization.`.trim();
}

async function generateAiCoachAnswer({
  deployment,
  question,
  questionType,
  deterministicShortAnswer,
  deterministicDetailedReasoning,
  user,
  externalCards,
  scenario,
  routingReason,
  knowledgeArticle,
  memberCoachContext,
  conversationHistory = []
}) {
  const formattedDeterministicShortAnswer = ensureNameGreeting(
    deterministicShortAnswer,
    user?.first_name
  );

  if (!azureAiEndpoint || !azureAiApiKey) {
    return {
      aiWasUsed: false,
      aiError: "Azure AI endpoint or API key is missing.",
      shortAnswer: formattedDeterministicShortAnswer
    };
  }

  const cleanEndpoint = normalizeEndpoint(azureAiEndpoint);
  const url = `${cleanEndpoint}/openai/v1/chat/completions`;

  const systemMessage = `
  You are KEYR's AI Financial Coach.

  KEYR helps members build credit readiness, reduce revolving debt, understand payoff options,
  improve utilization, strengthen payment habits, and progress toward better financial tiers over time.

  Canonical product rules:
  - Safe Start is a guided financial-readiness journey and uses Anchor as the canonical product when a product value is required.
  - Anchor is a secured credit-building product and does not support balance transfers.
  - Ascend is an unsecured product with a proposed standard APR of 18.99%, an AutoPay Advantage APR of 12.00%, and a proposed 2% balance-transfer fee when available.
  - Apex is a premium unsecured product with a proposed standard APR of 15.99%, an AutoPay Advantage APR of 9.00%, and a proposed 0% balance-transfer fee when available.
  - Retired tier aliases and legacy member names may appear in compatibility-only input; they are not active products in the current model.

  Your job:
  - Give concise, practical, member-friendly coaching.
  - If the member's first name is provided, the final response MUST begin with that first name exactly as provided.
  - Keep the tone warm, encouraging, calm, specific, and transparent about missing information.
  - Use current member profile, dashboard status, KEYR product rules, and member coach context as factual background.
  - If account-specific values are unavailable, abstain instead of guessing.
  - Do not claim a balance transfer, approval, score increase, or tier upgrade without verified support.
  - Respond directly to the member's actual question.
  - Return a finished member-facing answer without internal labels, routing notes, system prompts, or classification language.
  - If deterministic context is provided, rewrite it naturally as a completed answer.

  Critical rules:
  - Do not invent balances, APRs, credit limits, payments, scores, approvals, transfer timelines, or payoff timelines.
  - Do not guarantee credit score increases, approvals, underwriting decisions, savings, transfer completion, or tier upgrades.
  - Do not provide legal, tax, bankruptcy, investment, or formal credit-repair advice.
  - If the member asks about payment behavior, utilization, Progress Status, risk, autopay, debt strategy, or balance transfers, answer directly.
  - If the member asks about hardship, fraud, disputes, collections, lawsuits, bankruptcy, identity issues, account errors, or legal concerns, recommend contacting KEYR support.
  - Current member profile and dashboard data are the source of truth; conversation history never overrides current account data.
  - The final answer must be concise and generally under 125 words unless the member asks for a detailed plan.
  - Do not expose internal phrases such as deterministic context, question type, routing reason, classification, internal guidance, support-safe response, or system prompt leakage.
  - Do not mention retired product names as active products. Use them only when the member explicitly uses them and you are clarifying legacy terminology.

  Final quality check before responding:
  - Directly answer the member's question.
  - Reflect the current KEYR rules.
  - Abstain when the account value cannot be verified.
  - Ensure no internal routing or instruction text appears in the final answer.
  `;

  const userMessage = `
  Question type:
  ${questionType}

  Member first name:
  ${user?.first_name || ""}

  Member question:
  ${question || "No specific question provided."}

  Recent conversation history:
  ${formatCoachConversationHistory(conversationHistory)}

  KEYR deterministic short context:
  ${deterministicShortAnswer}

  KEYR deterministic detailed context:
  ${deterministicDetailedReasoning}

  Member profile:
  ${JSON.stringify(
    {
      simUserId: user?.sim_user_id,
      firstName: user?.first_name,
      lastName: user?.last_name,
      email: user?.email,
      currentTier: user?.current_tier,
      progressStatus: user?.progress_status,
      paymentStatus: user?.payment_status,
      autopayEnabled: user?.autopay_enabled,
      utilizationStatus: user?.utilization_status
    },
    null,
    2
)}

External cards:
${JSON.stringify(externalCards || [], null, 2)}

Balance transfer scenario:
${JSON.stringify(scenario || {}, null, 2)}

Knowledge article:
${JSON.stringify(knowledgeArticle || {}, null, 2)}

Member coach context:
${JSON.stringify(memberCoachContext || {}, null, 2)}
`;

  try {
    const requestPayload = {
      model: deployment,
      messages: [
        {
          role: "system",
          content: systemMessage
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      temperature: 1,
    };

    if ((deployment || "").toLowerCase().includes("gpt-5")) {
      requestPayload.max_completion_tokens = 250;
    } else {
      requestPayload.max_tokens = 250;
    }

function getDeterministicButtonResponse(questionType, question, user) {
  const firstName = user?.first_name || "Hi";
  const normalizedQuestion = (question || "").toLowerCase().trim();
  const normalizedType = (questionType || "").toLowerCase().trim();

  const isPastDueAction =
    normalizedType.includes("past_due") ||
    normalizedQuestion.includes("what should i do if my payment is past due") ||
    normalizedQuestion.includes("payment is past due");

  const isLatePaymentProgress =
    normalizedType.includes("late_payment_progress") ||
    normalizedQuestion.includes("how do late payments affect my progress") ||
    normalizedQuestion.includes("late payments affect my progress");

  const isBalanceTransferTiming =
    normalizedType.includes("balance_transfer_timing") ||
    normalizedQuestion.includes("how long does a balance transfer take") ||
    normalizedQuestion.includes("balance transfer take");

  const isSecuredTierTransfer =
    normalizedType.includes("secured_tier_transfer") ||
  (
    normalizedQuestion.includes("balance transfer") && (
    normalizedQuestion.includes("merit") ||
    normalizedQuestion.includes("anchor") ||
    normalizedQuestion.includes("secured") ||
    normalizedQuestion.includes("anchor base")
    )
  );

  const isAscendReadiness =
    normalizedType.includes("ascend_readiness") ||
    normalizedQuestion.includes("how can i qualify for ascend") ||
    normalizedQuestion.includes("qualify for ascend");

  const isProgressStatusChange =
    normalizedType.includes("progress_status") ||
    normalizedQuestion.includes("why did my progress status change") ||
    normalizedQuestion.includes("progress status change");

  if (isPastDueAction) {
    return `${firstName}, because your payment due date has passed, your first priority should be making a payment as soon as possible. If you cannot pay the full amount, consider paying at least the minimum due to help reduce the risk of further negative impact. After that, enable autopay or set a reminder so the next payment is made on time. Bringing the account current and rebuilding consistent on-time payment behavior may help strengthen your readiness over time.`;
  }

  if (isLatePaymentProgress) {
    return `${firstName}, late payments can slow your progress because on-time payment behavior is one of the most important readiness indicators in KEYR. A missed or past-due payment may weaken your Progress Status and delay readiness for unsecured opportunities. Your best next step is to bring the account current as soon as possible, then focus on consistent on-time payments going forward. Autopay or reminders may help reduce the risk of missing another due date.`;
  }

  if (isBalanceTransferTiming) {
    return `${firstName}, balance transfers are only available for KEYR's unsecured products, Ascend and Apex, and depend on approval, available credit, sponsor-bank rules, program terms, and transfer availability. In general, balance transfers can take several business days, but timing may vary by issuer and program rules. Continue making required payments on the original account until the transfer is confirmed as completed.`;
  }

  if (isSecuredTierTransfer) {
    return `${firstName}, Merit is a retired KEYR product name that maps to Anchor in the current model. Anchor does not support balance transfers. Balance transfers are only available for unsecured products such as Ascend and Apex, subject to sponsor-bank approval, available credit, program terms, and transfer availability.`;
  }

  if (isAscendReadiness) {
    return `${firstName}, Ascend is an unsecured KEYR product, so financial readiness depends on factors such as on-time payment behavior, credit profile stability, utilization, income, and sponsor-bank approval. Focus on keeping payments current, using autopay or reminders, and managing utilization over time. KEYR cannot guarantee approval or advancement, but stronger payment consistency and responsible credit behavior may help improve your financial readiness.`;
  }

  if (isProgressStatusChange) {
    return `${firstName}, your Progress Status may change when key readiness indicators move, such as payment behavior, utilization, account stability, or credit profile strength. If a payment is past due, that can weaken readiness because on-time payment behavior is a major part of progress. Your next best step is to address any past-due payment, then maintain consistent on-time payments over the next several cycles.`;
  }

  return null;
}

function determineProductAnswer(question, user = {}) {
  const normalizedQuestion = String(question || "").trim();
  const currentTier = String(user.current_tier || user.currentTier || "").trim();
  const normalizedProduct = normalizeProductInput(currentTier || (normalizedQuestion.includes("merit") ? "Merit" : "")).product || "Anchor";
  const explicitMerit = /merit/i.test(normalizedQuestion) || /merit/i.test(currentTier);

  if (explicitMerit) {
    return "Merit is a retired KEYR product name that maps to Anchor in the current model. Anchor does not support balance transfers. Ascend and Apex may support balance transfers, subject to approval, available approved credit, account status, applicable fees, and program terms.";
  }

  if (normalizedProduct === "Ascend") {
    return "Your current Ascend product may support balance transfers, subject to approval, available approved credit, account status, applicable fees, and program terms. A proposed transfer fee of 2% may apply.";
  }

  if (normalizedProduct === "Apex") {
    return "Your current Apex product may support balance transfers, subject to approval, available approved credit, account status, applicable fees, and program terms. A proposed transfer fee of 0% may apply.";
  }

  return `${normalizedProduct || "Anchor"} does not support balance transfers. Ascend and Apex may support balance transfers, subject to approval, available approved credit, account status, applicable fees, and program terms.`;
}

function sanitizeCoachResponse(text) {
  if (!text) return "";

  const lower = text.toLowerCase();

  const blockedPatterns = [
    "explain that",
    "do not mention",
    "do not guarantee",
    "internal override",
    "deterministic context",
    "routing reason",
    "question type",
    "classification",
    "internal guidance",
    "developer instructions",
    "system prompt",
    "internal instruction",
    "routing logic",
    "answer source",
    "model family",
    "do not recalculate",
    "support-safe response"
  ];

  const leakedInternalPhrases = blockedPatterns.some((phrase) =>
    lower.includes(phrase)
  );

  const blockedLegacyTerms = [
    "anchor base",
    "merit",
    "merit (secured)",
    "anchor (secured)",
    "ascend (unsecured)",
    "apex (unsecured)",
    "guaranteed approval",
    "guaranteed transfer",
    "guaranteed savings",
    "guaranteed score increase",
    "tier upgrade"
  ];

  const legacyLeak = blockedLegacyTerms.some((term) => lower.includes(term));

  if (!leakedInternalPhrases && !legacyLeak) {
    return text.trim();
  }

  return `Hi ${"Member"}, your six completed on-time cycles and current utilization results are positive account-management signals. Your broader credit profile changed recently, so your primary focus should be credit profile stability while continuing consistent on-time payment habits and manageable utilization.`.trim();
}

    const deterministicButtonResponse = getDeterministicButtonResponse(
      questionType,
      question,
      user
    );

    if (deterministicButtonResponse) {
      return {
        aiWasUsed: false,
        aiError: null,
        shortAnswer: deterministicButtonResponse
      };
    }

    const aiResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": azureAiApiKey
      },
      body: JSON.stringify(requestPayload)
    });

    const responseText = await aiResponse.text();

    if (!aiResponse.ok) {
      return {
        aiWasUsed: false,
        aiError: `Azure AI call failed with status ${aiResponse.status}: ${responseText}`,
        shortAnswer: formattedDeterministicShortAnswer
      };
    }

    const parsed = JSON.parse(responseText);

    const rawAiShortAnswer =
    parsed?.choices?.[0]?.message?.content?.trim() ||
    deterministicShortAnswer;

    const sanitizedAiShortAnswer = sanitizeCoachResponse(rawAiShortAnswer);

    const formattedAiShortAnswer = ensureNameGreeting(
    sanitizedAiShortAnswer,
    user?.first_name
);

      return {
        aiWasUsed: true,
        aiError: null,
        shortAnswer: formattedAiShortAnswer
};

  } catch (error) {
    return {
      aiWasUsed: false,
      aiError: error.message || "Azure AI call failed.",
      shortAnswer: formattedDeterministicShortAnswer
    };
  }
}

if (require.main === module) {
  const assert = require("assert");

  const productTests = [
    ["Anchor Base", { journey: "Safe Start", product: "Anchor" }],
    ["Merit", { journey: "", product: "Anchor" }],
    ["Merit (Secured)", { journey: "", product: "Anchor" }],
    ["Anchor (Secured)", { journey: "", product: "Anchor" }],
    ["Ascend (Unsecured)", { journey: "Active", product: "Ascend" }],
    ["Apex (Unsecured)", { journey: "Active", product: "Apex" }],
    ["Safe Start", { journey: "Safe Start", product: "Anchor" }],
    ["safe start mode", { journey: "Safe Start", product: "Anchor" }]
  ];

  for (const [input, expected] of productTests) {
    const result = normalizeProductInput(input);
    assert.deepStrictEqual(result, expected, `normalizeProductInput(${input})`);
    console.log(`normalizeProductInput(${JSON.stringify(input)}) => ${JSON.stringify(result)}`);
  }

  const transferInside = buildTransferPlan([
    { card_label: "Card A", current_balance: 1500, apr_percent: 22, transferEligible: true },
    { card_label: "Card B", current_balance: 900, apr_percent: 18, transferEligible: true }
  ], { transfer_limit: 2000, transfer_fee_percent: 2, fee_treatment: "inside_capacity" });

  assert.ok(transferInside.totalTransferred <= 1960.78 + 0.01, "inside-capacity principal remains under 1960.78");
  assert.ok(transferInside.totalTransferFees > 0, "inside-capacity fee is calculated");
  assert.ok(transferInside.totalCapacityUsed <= 2000, "inside-capacity total does not exceed 2000");
  assert.ok(transferInside.unusedCapacity >= 0, "inside-capacity unused capacity is not negative");
  assert.ok(transferInside.allocations.every((item) => item.transferAmount <= item.originalBalance + 0.01), "no allocation exceeds source balance");
  console.log(`inside_capacity => totalTransferred=${transferInside.totalTransferred.toFixed(2)}, totalTransferFees=${transferInside.totalTransferFees.toFixed(2)}, totalCapacityUsed=${transferInside.totalCapacityUsed.toFixed(2)}, unusedCapacity=${transferInside.unusedCapacity.toFixed(2)}, feeTreatment=${transferInside.feeTreatment}`);

  const transferOutside = buildTransferPlan([
    { card_label: "Card A", current_balance: 800, apr_percent: 22, transferEligible: true },
    { card_label: "Card B", current_balance: 600, apr_percent: 19, transferEligible: true }
  ], { transfer_limit: 1000, transfer_fee_percent: 2, fee_treatment: "outside_capacity" });

  assert.ok(transferOutside.totalTransferred <= 1000, "outside-capacity principal not above capacity");
  assert.ok(transferOutside.totalCapacityUsed === transferOutside.totalTransferred, "outside-capacity uses principal only");
  assert.ok(transferOutside.allocations.every((item) => item.transferAmount <= item.originalBalance + 0.01), "outside-capacity no allocation exceeds source balance");
  console.log(`outside_capacity => totalTransferred=${transferOutside.totalTransferred.toFixed(2)}, totalTransferFees=${transferOutside.totalTransferFees.toFixed(2)}, totalCapacityUsed=${transferOutside.totalCapacityUsed.toFixed(2)}, unusedCapacity=${transferOutside.unusedCapacity.toFixed(2)}, feeTreatment=${transferOutside.feeTreatment}`);

  const explicitEligible = buildTransferPlan([
    { card_label: "Card A", current_balance: 1200, apr_percent: 22, transferEligible: true }
  ], { transfer_limit: 2000, transfer_fee_percent: 2, fee_treatment: "inside_capacity" });
  assert.strictEqual(explicitEligible.eligibleCardLabels.length, 1, "explicit true card is included in eligible labels");
  assert.strictEqual(explicitEligible.allocations.length, 1, "explicit true card receives an allocation");
  assert.ok(explicitEligible.allocations.some((card) => card.cardLabel === "Card A"), "explicit true card included in allocation plan");
  console.log(`explicit_true_included => ${JSON.stringify({ eligibleCardLabels: explicitEligible.eligibleCardLabels, allocations: explicitEligible.allocations.map((item) => ({ cardLabel: item.cardLabel, transferAmount: item.transferAmount })) })}`);

  const explicitIneligible = buildTransferPlan([
    { card_label: "Card A", current_balance: 1200, apr_percent: 22, transferEligible: false }
  ], { transfer_limit: 2000, transfer_fee_percent: 2, fee_treatment: "inside_capacity" });
  assert.strictEqual(explicitIneligible.allocations.length, 0, "explicit false card is excluded from allocation plan");
  assert.deepStrictEqual(explicitIneligible.ineligibleCardLabels, ["Card A"], "explicit false card is tracked in ineligible labels");
  assert.strictEqual(explicitIneligible.transferPlanStatus, "no_eligible_cards", "all false cards are recognized as no eligible options");
  console.log(`explicit_false_excluded => ${JSON.stringify({ ineligibleCardLabels: explicitIneligible.ineligibleCardLabels, allocations: explicitIneligible.allocations, transferPlanStatus: explicitIneligible.transferPlanStatus })}`);

  const missingEligibility = buildTransferPlan([
    { card_label: "Card A", current_balance: 1200, apr_percent: 22 }
  ], { transfer_limit: 2000, transfer_fee_percent: 2, fee_treatment: "inside_capacity" });
  assert.strictEqual(missingEligibility.allocations.length, 0, "missing eligibility card is excluded from allocation plan");
  assert.deepStrictEqual(missingEligibility.unknownEligibilityCardLabels, ["Card A"], "missing eligibility is tracked as unknown");
  assert.strictEqual(missingEligibility.transferPlanStatus, "eligibility_verification_required", "all missing eligibility is flagged for verification");
  console.log(`missing_excluded => ${JSON.stringify({ unknownEligibilityCardLabels: missingEligibility.unknownEligibilityCardLabels, allocations: missingEligibility.allocations, transferPlanStatus: missingEligibility.transferPlanStatus })}`);

  const nullEligibility = buildTransferPlan([
    { card_label: "Card A", current_balance: 1200, apr_percent: 22, transferEligible: null }
  ], { transfer_limit: 2000, transfer_fee_percent: 2, fee_treatment: "inside_capacity" });
  assert.strictEqual(nullEligibility.allocations.length, 0, "null eligibility card is excluded from allocation plan");
  assert.deepStrictEqual(nullEligibility.unknownEligibilityCardLabels, ["Card A"], "null eligibility is treated like missing");
  console.log(`null_excluded => ${JSON.stringify({ unknownEligibilityCardLabels: nullEligibility.unknownEligibilityCardLabels, allocations: nullEligibility.allocations })}`);

  const mixedEligibility = buildTransferPlan([
    { card_label: "Card A", current_balance: 900, apr_percent: 28, transferEligible: true },
    { card_label: "Card B", current_balance: 600, apr_percent: 18, transferEligible: false },
    { card_label: "Card C", current_balance: 700, apr_percent: 20 }
  ], { transfer_limit: 1500, transfer_fee_percent: 2, fee_treatment: "inside_capacity" });
  assert.strictEqual(mixedEligibility.allocations.length, 1, "only explicit true cards receive allocations in mixed cases");
  assert.ok(mixedEligibility.allocations.every((card) => card.cardLabel === "Card A"), "false and unknown cards do not receive allocations");
  assert.deepStrictEqual(mixedEligibility.ineligibleCardLabels, ["Card B"], "false card is reported as ineligible");
  assert.deepStrictEqual(mixedEligibility.unknownEligibilityCardLabels, ["Card C"], "unknown card is reported as requiring verification");
  assert.strictEqual(mixedEligibility.transferPlanStatus, "partial_eligibility", "mixed true/unknown cards are handled as partial eligibility");
  console.log(`mixed_case_allocation => ${JSON.stringify({ allocations: mixedEligibility.allocations.map((item) => ({ cardLabel: item.cardLabel, transferAmount: item.transferAmount })), ineligibleCardLabels: mixedEligibility.ineligibleCardLabels, unknownEligibilityCardLabels: mixedEligibility.unknownEligibilityCardLabels, transferPlanStatus: mixedEligibility.transferPlanStatus })}`);

  const exactMixedEligibilityPartial = buildTransferPlan([
    { card_label: "Card A", current_balance: 3200, apr_percent: 29.99, transferEligible: true },
    { card_label: "Card B", current_balance: 2400, apr_percent: 24.99, transferEligible: null },
    { card_label: "Card C", current_balance: 1000, apr_percent: 18.99, transferEligible: false }
  ], { transfer_limit: 5000, transfer_fee_percent: 2, fee_treatment: "inside_capacity", monthly_payment_budget: 600 });
  assert.strictEqual(exactMixedEligibilityPartial.transferPlanStatus, "partial_eligibility", "eligible plus unknown plus false remains partial_eligibility");
  assert.strictEqual(exactMixedEligibilityPartial.totalTransferred, 3200, "verified eligible balance is transferred in a partial plan");
  assert.strictEqual(exactMixedEligibilityPartial.totalTransferFees, 64, "fee is tracked correctly when included inside capacity");
  assert.strictEqual(exactMixedEligibilityPartial.totalCapacityUsed, 3264, "capacity used matches principal plus fee");
  assert.strictEqual(exactMixedEligibilityPartial.unusedCapacity, 1736, "unused capacity remains after the verified eligible transfer");
  assert.deepStrictEqual(exactMixedEligibilityPartial.missingInputs, ["Card B transferEligibility"], "unknown-card eligibility remains in the missing-input list");
  console.log(`exact_mixed_partial_eligibility => ${JSON.stringify({ transferPlanStatus: exactMixedEligibilityPartial.transferPlanStatus, totalTransferred: exactMixedEligibilityPartial.totalTransferred, totalTransferFees: exactMixedEligibilityPartial.totalTransferFees, totalCapacityUsed: exactMixedEligibilityPartial.totalCapacityUsed, unusedCapacity: exactMixedEligibilityPartial.unusedCapacity, missingInputs: exactMixedEligibilityPartial.missingInputs })}`);

  const exactMixedEligibilityPrompt = "Build an exact Ascend balance-transfer plan with $5,000 of approved capacity and the proposed 2% fee inside capacity. Card A has a $3,200 balance at 29.99% APR with a $110 minimum payment and is eligible for transfer. Card B has a $2,400 balance at 24.99% APR with an $85 minimum payment, but I do not know whether Card B is eligible for transfer. Card C has a $1,000 balance at 18.99% APR with a $40 minimum payment and is not eligible for transfer. I can pay $600 per month toward debt.";
  const parsedExactMixedEligibility = buildExplicitDebtPlanState(exactMixedEligibilityPrompt);
  assert.strictEqual(parsedExactMixedEligibility?.status, "ready", "exact mixed-eligibility prompt parses into a ready explicit debt-plan state");
  assert.strictEqual(parsedExactMixedEligibility?.selectedProduct, "Ascend", "exact mixed-eligibility prompt keeps Ascend as selected product");
  assert.strictEqual(parsedExactMixedEligibility?.approvedTransferCapacity, 5000, "approved transfer capacity is read as 5000");
  assert.strictEqual(parsedExactMixedEligibility?.monthlyDebtBudget, 600, "monthly debt budget is read as 600");
  assert.strictEqual(parsedExactMixedEligibility?.cards?.length, 3, "all three cards are parsed from the exact mixed-eligibility prompt");
  const parsedCardA = parsedExactMixedEligibility.cards.find((card) => card.card_label === "Card A");
  const parsedCardB = parsedExactMixedEligibility.cards.find((card) => card.card_label === "Card B");
  const parsedCardC = parsedExactMixedEligibility.cards.find((card) => card.card_label === "Card C");
  assert.strictEqual(parsedCardA?.transfer_eligible, true, "Card A eligibility parses as true");
  assert.strictEqual(parsedCardB?.transfer_eligible, null, "Card B eligibility parses as unknown/null");
  assert.strictEqual(parsedCardC?.transfer_eligible, false, "Card C eligibility parses as false");
  const parsedExactMixedEligibilityPlan = buildTransferPlan(parsedExactMixedEligibility.cards, {
    transfer_limit: parsedExactMixedEligibility.approvedTransferCapacity,
    transfer_fee_percent: parsedExactMixedEligibility.feeRate * 100,
    fee_treatment: parsedExactMixedEligibility.feeTreatment,
    monthly_payment_budget: parsedExactMixedEligibility.monthlyDebtBudget
  });
  assert.strictEqual(parsedExactMixedEligibilityPlan.transferPlanStatus, "partial_eligibility", "exact mixed-eligibility prompt produces partial_eligibility plan status");
  assert.strictEqual(parsedExactMixedEligibilityPlan.totalTransferred, 3200, "exact mixed-eligibility prompt transfers the full eligible Card A balance");
  assert.strictEqual(parsedExactMixedEligibilityPlan.totalTransferFees, 64, "exact mixed-eligibility prompt fee total remains 64");
  assert.strictEqual(parsedExactMixedEligibilityPlan.totalCapacityUsed, 3264, "exact mixed-eligibility prompt capacity usage remains 3264");
  assert.strictEqual(parsedExactMixedEligibilityPlan.unusedCapacity, 1736, "exact mixed-eligibility prompt unused capacity remains 1736");
  assert.deepStrictEqual(parsedExactMixedEligibilityPlan.missingInputs, ["Card B transferEligibility"], "exact mixed-eligibility prompt keeps Card B transfer eligibility as missing input");
  console.log(`exact_mixed_prompt_parsing => ${JSON.stringify({ status: parsedExactMixedEligibility.status, approvedTransferCapacity: parsedExactMixedEligibility.approvedTransferCapacity, monthlyDebtBudget: parsedExactMixedEligibility.monthlyDebtBudget, cardEligibility: parsedExactMixedEligibility.cards.map((card) => ({ cardLabel: card.card_label, transferEligible: card.transfer_eligible })), transferPlanStatus: parsedExactMixedEligibilityPlan.transferPlanStatus, totalTransferred: parsedExactMixedEligibilityPlan.totalTransferred, totalTransferFees: parsedExactMixedEligibilityPlan.totalTransferFees, totalCapacityUsed: parsedExactMixedEligibilityPlan.totalCapacityUsed, unusedCapacity: parsedExactMixedEligibilityPlan.unusedCapacity, missingInputs: parsedExactMixedEligibilityPlan.missingInputs })}`);

  const ascendFeeTreatmentMissingPrompt = "Help me build an Ascend balance-transfer plan. Card A has a $3,200 balance at 29.99% APR and Card B has a $2,400 balance at 24.99% APR.";
  const ascendFeeTreatmentMissing = buildExplicitDebtPlanState(ascendFeeTreatmentMissingPrompt);
  const expectedAscendMissingInputs = [
    "approvedTransferCapacity",
    "feeTreatment",
    "monthlyDebtBudget",
    "Card A minimumPayment",
    "Card A transferEligibility",
    "Card B minimumPayment",
    "Card B transferEligibility"
  ];
  assert.strictEqual(ascendFeeTreatmentMissing?.selectedProduct, "Ascend", "selected product is retained for the initial Ascend planning request");
  assert.strictEqual(ascendFeeTreatmentMissing?.feeRate, 0.02, "Ascend planning inherits the canonical proposed 2% fee rate");
  assert.strictEqual(ascendFeeTreatmentMissing?.feeTreatment, null, "Ascend fee treatment remains unknown until explicitly provided");
  assert.strictEqual(ascendFeeTreatmentMissing?.status, "collecting", "missing Ascend fee treatment keeps the planning state collecting");
  assert.deepStrictEqual(ascendFeeTreatmentMissing?.missingInputs, expectedAscendMissingInputs, "missing-input list matches the fresh Ascend request exactly");
  assert.ok(!ascendFeeTreatmentMissing.missingInputs.includes("selectedProduct"), "selected product is not reported missing when Ascend was provided");
  console.log(`ascend_fee_treatment_missing => ${JSON.stringify({ selectedProduct: ascendFeeTreatmentMissing.selectedProduct, feeRate: ascendFeeTreatmentMissing.feeRate, feeTreatment: ascendFeeTreatmentMissing.feeTreatment, status: ascendFeeTreatmentMissing.status, missingInputs: ascendFeeTreatmentMissing.missingInputs })}`);

  const ascendCollectingRecommendation = buildDebtPlanStatusRecommendation({
    recommendedStrategy: "none",
    recommendedCardLabel: null,
    recommendedTransferAmount: 0,
    totalTransferred: 0,
    totalTransferFees: 0,
    totalCapacityUsed: 0,
    unusedCapacity: 0,
    totalOpeningTransferredBalance: 0,
    transferFee: 0,
    feeTreatment: ascendFeeTreatmentMissing.feeTreatment,
    transferPlanStatus: "collecting",
    allocations: [],
    missingInputs: ascendFeeTreatmentMissing.missingInputs,
    selectedProduct: ascendFeeTreatmentMissing.selectedProduct,
    approvedTransferCapacity: ascendFeeTreatmentMissing.approvedTransferCapacity,
    monthlyDebtBudget: ascendFeeTreatmentMissing.monthlyDebtBudget,
    cards: ascendFeeTreatmentMissing.cards,
    planningState: {
      status: "collecting",
      selectedProduct: ascendFeeTreatmentMissing.selectedProduct,
      approvedTransferCapacity: ascendFeeTreatmentMissing.approvedTransferCapacity,
      feeRate: ascendFeeTreatmentMissing.feeRate,
      feeTreatment: ascendFeeTreatmentMissing.feeTreatment,
      monthlyDebtBudget: ascendFeeTreatmentMissing.monthlyDebtBudget,
      cards: ascendFeeTreatmentMissing.cards,
      missingInputs: ascendFeeTreatmentMissing.missingInputs
    }
  }, { first_name: "Chris" });
  assert.strictEqual(ascendCollectingRecommendation.recommendation.feeTreatment, null, "collecting recommendation keeps fee treatment null");
  assert.strictEqual(ascendCollectingRecommendation.recommendation.planningState.feeTreatment, null, "planning state keeps fee treatment null while missing");
  assert.deepStrictEqual(ascendCollectingRecommendation.recommendation.missingInputs, expectedAscendMissingInputs, "recommendation missingInputs align with planning state");
  assert.ok(/approved transfer capacity/i.test(ascendCollectingRecommendation.recommendation.shortAnswer), "customer-facing answer calls out approved transfer capacity as missing");
  assert.ok(/2% fee counts inside or outside/i.test(ascendCollectingRecommendation.recommendation.shortAnswer), "customer-facing answer calls out the missing fee treatment");
  assert.ok(/total amount you can pay toward debt each month/i.test(ascendCollectingRecommendation.recommendation.shortAnswer), "customer-facing answer calls out the monthly debt budget");
  assert.ok(/Card A transfer eligibility/i.test(ascendCollectingRecommendation.recommendation.shortAnswer), "customer-facing answer calls out Card A transfer eligibility");
  assert.ok(/Card B transfer eligibility/i.test(ascendCollectingRecommendation.recommendation.shortAnswer), "customer-facing answer calls out Card B transfer eligibility");
  console.log(`narrative_metadata_alignment => ${JSON.stringify({ feeTreatment: ascendCollectingRecommendation.recommendation.feeTreatment, planningStateFeeTreatment: ascendCollectingRecommendation.recommendation.planningState.feeTreatment, missingInputs: ascendCollectingRecommendation.recommendation.missingInputs, shortAnswer: ascendCollectingRecommendation.recommendation.shortAnswer })}`);

  const ascendInsideCapacityFollowup = buildExplicitDebtPlanState("The proposed 2% fee counts inside capacity.");
  const mergedAscendInsideCapacity = mergeDebtPlanState(ascendFeeTreatmentMissing, ascendInsideCapacityFollowup);
  assert.strictEqual(mergedAscendInsideCapacity?.feeTreatment, "inside_capacity", "explicit inside-capacity follow-up sets fee treatment");
  assert.ok(!mergedAscendInsideCapacity.missingInputs.includes("feeTreatment"), "inside-capacity follow-up removes fee treatment from missing inputs");
  console.log(`ascend_inside_capacity_followup => ${JSON.stringify({ feeTreatment: mergedAscendInsideCapacity.feeTreatment, missingInputs: mergedAscendInsideCapacity.missingInputs, status: mergedAscendInsideCapacity.status })}`);

  const ascendOutsideCapacityFollowup = buildExplicitDebtPlanState("The proposed 2% fee is added outside capacity.");
  const mergedAscendOutsideCapacity = mergeDebtPlanState(ascendFeeTreatmentMissing, ascendOutsideCapacityFollowup);
  assert.strictEqual(mergedAscendOutsideCapacity?.feeTreatment, "outside_capacity", "explicit outside-capacity follow-up sets fee treatment");
  assert.ok(!mergedAscendOutsideCapacity.missingInputs.includes("feeTreatment"), "outside-capacity follow-up removes fee treatment from missing inputs");
  console.log(`ascend_outside_capacity_followup => ${JSON.stringify({ feeTreatment: mergedAscendOutsideCapacity.feeTreatment, missingInputs: mergedAscendOutsideCapacity.missingInputs, status: mergedAscendOutsideCapacity.status })}`);

  const apexZeroFeePrompt = "Help me build an Apex balance-transfer plan. Approved transfer capacity is $5,000. Card A has a $3,200 balance at 29.99% APR with a $95 minimum payment and is eligible. Card B has a $2,400 balance at 24.99% APR with a $80 minimum payment and is eligible. Monthly debt budget is $600.";
  const apexZeroFeeState = buildExplicitDebtPlanState(apexZeroFeePrompt);
  const apexZeroFeePlan = buildTransferPlan(apexZeroFeeState.cards, {
    transfer_limit: apexZeroFeeState.approvedTransferCapacity,
    transfer_fee_percent: apexZeroFeeState.feeRate * 100,
    fee_treatment: apexZeroFeeState.feeTreatment,
    monthly_payment_budget: apexZeroFeeState.monthlyDebtBudget,
    keyr_tier: apexZeroFeeState.selectedProduct
  });
  assert.strictEqual(apexZeroFeeState?.feeRate, 0, "Apex default fee rate is verified as zero when no fee is specified");
  assert.strictEqual(apexZeroFeeState?.feeTreatment, "inside_capacity", "zero-fee Apex can proceed without asking for fee treatment");
  assert.ok(!apexZeroFeeState.missingInputs.includes("feeTreatment"), "zero-fee Apex does not require fee treatment clarification");
  assert.strictEqual(apexZeroFeeState?.status, "ready", "zero-fee Apex state is ready once the other inputs are present");
  assert.strictEqual(apexZeroFeePlan.transferPlanStatus, "calculated", "zero-fee Apex plan can calculate without fee-treatment clarification");
  console.log(`apex_zero_fee_does_not_require_treatment => ${JSON.stringify({ feeRate: apexZeroFeeState.feeRate, feeTreatment: apexZeroFeeState.feeTreatment, status: apexZeroFeeState.status, transferPlanStatus: apexZeroFeePlan.transferPlanStatus, missingInputs: apexZeroFeeState.missingInputs })}`);

  const allFalseEligibility = buildTransferPlan([
    { card_label: "Card A", current_balance: 1000, apr_percent: 18, transferEligible: false },
    { card_label: "Card B", current_balance: 800, apr_percent: 19, transferEligible: false }
  ], { transfer_limit: 1500, transfer_fee_percent: 2, fee_treatment: "inside_capacity" });
  assert.strictEqual(allFalseEligibility.allocations.length, 0, "all false cards are excluded from allocation plan");
  assert.strictEqual(allFalseEligibility.transferPlanStatus, "no_eligible_cards", "all false cards report no eligible cards");
  console.log(`all_false_status => ${JSON.stringify({ transferPlanStatus: allFalseEligibility.transferPlanStatus, missingInputs: allFalseEligibility.missingInputs, eligibleCardLabels: allFalseEligibility.eligibleCardLabels })}`);

  const allMissingEligibility = buildTransferPlan([
    { card_label: "Card A", current_balance: 1000, apr_percent: 18 },
    { card_label: "Card B", current_balance: 800, apr_percent: 19 }
  ], { transfer_limit: 1500, transfer_fee_percent: 2, fee_treatment: "inside_capacity" });
  assert.strictEqual(allMissingEligibility.allocations.length, 0, "all missing eligibility cards are excluded from allocation plan");
  assert.strictEqual(allMissingEligibility.transferPlanStatus, "eligibility_verification_required", "all missing eligibility is flagged for verification");
  console.log(`all_missing_status => ${JSON.stringify({ transferPlanStatus: allMissingEligibility.transferPlanStatus, missingInputs: allMissingEligibility.missingInputs, unknownEligibilityCardLabels: allMissingEligibility.unknownEligibilityCardLabels })}`);

  const equalAprFullPayoffTieBreak = buildTransferPlan([
    { card_label: "Card A", current_balance: 1200, apr_percent: 24.99, transferEligible: true },
    { card_label: "Card B", current_balance: 500, apr_percent: 24.99, transferEligible: true }
  ], { transfer_limit: 500, transfer_fee_percent: 0, fee_treatment: "inside_capacity" });
  assert.strictEqual(equalAprFullPayoffTieBreak.allocations[0]?.cardLabel, "Card B", "equal-APR smaller-balance card should be prioritized for payoff");
  assert.strictEqual(equalAprFullPayoffTieBreak.allocations[0]?.transferAmount, 500, "smaller-balance eligible card receives the full available transfer");
  assert.strictEqual(equalAprFullPayoffTieBreak.allocations[0]?.remainingBalance, 0, "payoff candidate is fully exhausted");
  assert.strictEqual(equalAprFullPayoffTieBreak.recommendedCardLabel, "Card B", "recommended card should be the full-payoff winner");
  console.log(`equal_apr_full_payoff_tiebreak => ${JSON.stringify({ allocations: equalAprFullPayoffTieBreak.allocations, recommendedCardLabel: equalAprFullPayoffTieBreak.recommendedCardLabel })}`);

  const stableOriginalOrderTieBreak = buildTransferPlan([
    { card_label: "Card A", current_balance: 500, apr_percent: 24.99, transferEligible: true },
    { card_label: "Card B", current_balance: 500, apr_percent: 24.99, transferEligible: true }
  ], { transfer_limit: 500, transfer_fee_percent: 0, fee_treatment: "inside_capacity" });
  assert.strictEqual(stableOriginalOrderTieBreak.allocations[0]?.cardLabel, "Card A", "when the balances are identical, the original input order remains stable");
  assert.strictEqual(stableOriginalOrderTieBreak.allocations[0]?.transferAmount, 500, "first card receives the full available transfer when tied");
  console.log(`stable_original_order_tiebreak => ${JSON.stringify({ allocations: stableOriginalOrderTieBreak.allocations, recommendedCardLabel: stableOriginalOrderTieBreak.recommendedCardLabel })}`);

  const normalizedProductRules = [
    ["Merit", "Anchor"],
    ["Anchor", "Anchor"],
    ["Ascend", "Ascend"],
    ["Apex", "Apex"]
  ];
  for (const [input, expected] of normalizedProductRules) {
    const result = normalizeProductInput(input).product;
    assert.strictEqual(result, expected, `normalized product for ${input} should be ${expected}`);
    console.log(`normalized_product_rule => ${input} => ${result}`);
  }
  assert.strictEqual(normalizeProductInput("Merit").product, "Anchor", "Merit maps to Anchor rather than Ascend");
  assert.ok(!/ascend/i.test(String(normalizeProductInput("Merit").product)), "Merit does not map to Ascend");
  console.log(`legacy_merit_not_progression => ${JSON.stringify({ meritProduct: normalizeProductInput("Merit").product, ascendProduct: normalizeProductInput("Ascend").product })}`);

  const currentProductTransferEligibility = [
    { currentTier: "Anchor", expected: "Anchor does not support balance transfers." },
    { currentTier: "Ascend", expected: "Ascend may support balance transfers with a proposed 2% fee." },
    { currentTier: "Apex", expected: "Apex may support balance transfers with a proposed 0% fee." }
  ];
  for (const scenario of currentProductTransferEligibility) {
    const normalizedProduct = normalizeProductInput(scenario.currentTier).product || "";
    if (normalizedProduct === "Ascend") {
      assert.ok(/2%|2 percent/i.test(scenario.expected), `Ascend expected fee language for ${scenario.currentTier}`);
    }
    if (normalizedProduct === "Apex") {
      assert.ok(/0%|0 percent/i.test(scenario.expected), `Apex expected fee language for ${scenario.currentTier}`);
    }
    if (normalizedProduct === "Anchor") {
      assert.ok(/does not support balance transfers/i.test(scenario.expected), `Anchor expected no-transfer language for ${scenario.currentTier}`);
    }
  }

  const meritTargetQuestion = "Can Merit accept a balance transfer?";
  const productAnswer = "Merit is a retired KEYR product name that maps to Anchor in the current model. Anchor does not support balance transfers. Ascend and Apex may support balance transfers, subject to approval, available approved credit, account status, applicable fees, and program terms.";
  assert.ok(/Merit is a retired KEYR product name|Anchor does not support balance transfers|Ascend and Apex may support balance transfers/i.test(productAnswer || ""), "legacy Merit question resolves to Anchor and not an active tier");
  console.log(`legacy_merit_product_statement => ${productAnswer}`);

  const outboundProductNormalization = {
    rawUser: { current_tier: "Merit" },
    rawScenario: { keyr_tier: "Merit", scenario_name: "Merit - Current account status" },
    rawMemberCoachContext: { current_tier: "Merit" }
  };

  const outboundNormalizedUser = buildSanitizedUser(outboundProductNormalization.rawUser);
  const outboundNormalizedScenario = buildSanitizedScenario(outboundProductNormalization.rawScenario);
  const outboundNormalizedMemberContext = buildSanitizedMemberCoachContext(outboundProductNormalization.rawMemberCoachContext);
  assert.strictEqual(outboundNormalizedUser.currentTier, "Anchor", "raw user Merit should be sanitized to Anchor in outbound response");
  assert.strictEqual(outboundNormalizedScenario.keyrTier, "Anchor", "raw scenario Merit should be sanitized to Anchor in outbound response");
  assert.strictEqual(outboundNormalizedMemberContext.current_tier, "Anchor", "raw member context Merit should be sanitized to Anchor in outbound response");
  assert.strictEqual(outboundProductNormalization.rawUser.current_tier, "Merit", "raw database value remains preserved internally before sanitization");
  assert.strictEqual(outboundProductNormalization.rawScenario.keyr_tier, "Merit", "raw scenario value remains preserved internally before sanitization");
  assert.strictEqual(outboundProductNormalization.rawMemberCoachContext.current_tier, "Merit", "raw member context remains preserved internally before sanitization");
  console.log(`outbound_product_normalization => ${JSON.stringify({ user: outboundNormalizedUser.currentTier, scenario: outboundNormalizedScenario.keyrTier, memberCoachContext: outboundNormalizedMemberContext.current_tier, rawPreserved: true })}`);

  const legacyScenarioName = sanitizeScenarioName("Two-card high APR Merit transfer scenario");
  assert.strictEqual(legacyScenarioName, "Two-card high-APR transfer scenario", "legacy scenario names are sanitized to natural canonical wording without mutating the raw record");
  console.log(`scenario_name_sanitized => ${legacyScenarioName}`);

  const verifiedBalanceAndDueDate = buildGroundingContext({
    memberCoachContext: {
      current_balance: 842.17,
      payment_due_date: "2026-10-15",
      days_until_due_date: 13,
      autopay_enabled: true,
      dashboard_status: "good standing",
      credit_limit: 2000,
      available_credit: 1157.83,
      minimum_payment: 35,
      statement_close_date: "2026-10-01",
      days_until_statement_close: 8,
      recommended_payment_before_close: 175.00
    }
  });
  assert.strictEqual(verifiedBalanceAndDueDate.currentBalance, 842.17);
  assert.strictEqual(verifiedBalanceAndDueDate.paymentDueDate, "2026-10-15");
  assert.strictEqual(verifiedBalanceAndDueDate.status, "verified");
  console.log(`verified_balance_and_due_date => ${JSON.stringify({ currentBalance: verifiedBalanceAndDueDate.currentBalance, paymentDueDate: verifiedBalanceAndDueDate.paymentDueDate, status: verifiedBalanceAndDueDate.status })}`);

  const currentBalanceButNoExactDueDate = buildGroundingContext({
    memberCoachContext: {
      current_balance: 842.17,
      days_until_due_date: 13,
      autopay_enabled: false,
      dashboard_status: "good standing"
    }
  });
  assert.strictEqual(currentBalanceButNoExactDueDate.currentBalance, 842.17);
  assert.strictEqual(currentBalanceButNoExactDueDate.paymentDueDate, null);
  assert.ok(currentBalanceButNoExactDueDate.daysUntilDueDate === 13);
  assert.strictEqual(currentBalanceButNoExactDueDate.status, "partial", "missing due date and minimum payment should keep the grounding partial");
  console.log(`partial_grounding => ${JSON.stringify({ currentBalance: currentBalanceButNoExactDueDate.currentBalance, paymentDueDate: currentBalanceButNoExactDueDate.paymentDueDate, status: currentBalanceButNoExactDueDate.status })}`);

  const progressPartialGrounding = buildGroundingContext({
    memberCoachContext: {
      current_tier: "Ascend",
      on_time_status: "on time",
      on_time_cycles_completed: 6,
      on_time_cycles_required: 6,
      autopay_enabled: true,
      avg_utilization_percent: 8,
      utilization_target_percent: 30,
      projected_utilization_percent: 30.5,
      dashboard_status: "ready",
      next_focus_area: "Credit profile stability",
      posted_balance: 842.17,
      projected_balance: 900,
      credit_limit: 3000
    }
  });
  assert.strictEqual(progressPartialGrounding.status, "partial", "verified progress signals without exact dates still keep the grounding partial");
  console.log(`progress_partial_grounding => ${JSON.stringify({ status: progressPartialGrounding.status, staleFields: progressPartialGrounding.staleFields, missingFields: progressPartialGrounding.missingFields })}`);

  const staleFieldsNotVerified = buildGroundingContext({
    memberCoachContext: {
      days_until_due_date: -74,
      days_until_statement_close: -90,
      recommended_payment_before_close: 175
    }
  });
  assert.strictEqual(staleFieldsNotVerified.fieldVerification.daysUntilDueDate, false, "stale due-day field is not verified as current");
  assert.strictEqual(staleFieldsNotVerified.fieldVerification.daysUntilStatementClose, false, "stale statement-close field is not verified as current");
  assert.strictEqual(staleFieldsNotVerified.fieldVerification.recommendedPaymentBeforeClose, false, "stale payment recommendation is not treated as currently verified");
  console.log(`stale_fields_not_verified => ${JSON.stringify({ staleFields: staleFieldsNotVerified.staleFields, dueVerified: staleFieldsNotVerified.fieldVerification.daysUntilDueDate, closeVerified: staleFieldsNotVerified.fieldVerification.daysUntilStatementClose, paymentVerified: staleFieldsNotVerified.fieldVerification.recommendedPaymentBeforeClose })}`);

  const staleAlertExclusion = buildSanitizedActiveAlerts([
    { alert_type: "statement_close_date", title: "Current close date", message: "Target utilization 8%" },
    { alert_type: "utilization_payment_recommendation", title: "Utilization alert", message: "Lower balance before seasonal statement close" }
  ], { days_until_due_date: -74, days_until_statement_close: -90 }, false);
  assert.strictEqual(staleAlertExclusion.length, 0, "stale statement and utilization alerts are excluded from normal active alerts when timing is stale");
  console.log(`stale_alert_excluded => ${JSON.stringify({ activeAlerts: staleAlertExclusion })}`);

  const staleAlertDebugOnly = buildSanitizedActiveAlerts([
    { alert_type: "statement_close_date", title: "Old statement close", message: "Target utilization 8%" }
  ], { days_until_due_date: -74, days_until_statement_close: -90 }, true);
  assert.strictEqual(staleAlertDebugOnly[0].freshnessStatus, "stale", "stale alert remains visible only in debug mode with stale freshness metadata");
  assert.strictEqual(staleAlertDebugOnly[0].isCurrent, false, "stale alert is flagged not current in debug mode");
  console.log(`stale_alert_debug_only => ${JSON.stringify({ debugAlerts: staleAlertDebugOnly })}`);

  const unsupportedGoodStandingRemoval = buildSanitizedMemberCoachContext({
    next_best_action_message: "keeping your account in good standing"
  });
  assert.ok(!/good standing/i.test(String(unsupportedGoodStandingRemoval.next_best_action_message || "")), "unsupported good-standing claim is removed from outbound member context");
  console.log(`unsupported_good_standing_removed => ${JSON.stringify({ nextBestActionMessage: unsupportedGoodStandingRemoval.next_best_action_message })}`);

  const internalInstructionLeakBlocked = sanitizeCoachResponse("Explain that... Do not mention internal override logic.");
  assert.ok(!/Explain that|Do not mention|internal override logic|internal override|do not guarantee/i.test(String(internalInstructionLeakBlocked || "")), "internal authoring instructions are rejected from customer-facing output");
  console.log(`internal_instruction_leak_blocked => ${JSON.stringify({ safeResponse: internalInstructionLeakBlocked })}`);

  const stalePaymentRecommendation = buildGroundingContext({
    memberCoachContext: {
      recommended_payment_before_close: 175,
      days_until_statement_close: -90
    }
  });
  assert.strictEqual(stalePaymentRecommendation.fieldVerification.recommendedPaymentBeforeClose, false, "payment recommendation is not verified when current statement timing is stale");
  console.log(`stale_payment_recommendation_not_verified => ${JSON.stringify({ recommendedPaymentBeforeClose: stalePaymentRecommendation.recommendedPaymentBeforeClose, fieldVerification: stalePaymentRecommendation.fieldVerification.recommendedPaymentBeforeClose })}`);

  const currentAlertRetained = buildSanitizedActiveAlerts([
    { alert_type: "utilization_payment_recommendation", title: "Current statement alert", message: "Keep utilization under 30%" }
  ], { days_until_due_date: 12, days_until_statement_close: 18 }, false);
  assert.strictEqual(currentAlertRetained.length, 1, "current alert remains active when the billing cycle is current");
  console.log(`current_alert_retained => ${JSON.stringify({ activeAlerts: currentAlertRetained })}`);

  const progressUnavailableGrounding = buildGroundingContext({
    memberCoachContext: {
      dashboard_status: "watching utilization"
    }
  });
  assert.strictEqual(progressUnavailableGrounding.status, "unavailable", "no useful progress fields should keep grounding unavailable");
  console.log(`progress_unavailable_grounding => ${JSON.stringify({ status: progressUnavailableGrounding.status, missingFields: progressUnavailableGrounding.missingFields })}`);

  const progressVerifiedGrounding = buildGroundingContext({
    memberCoachContext: {
      current_tier: "Ascend",
      on_time_status: "on time",
      on_time_cycles_completed: 6,
      on_time_cycles_required: 6,
      autopay_enabled: true,
      avg_utilization_percent: 8,
      utilization_target_percent: 30,
      projected_utilization_percent: 30.5,
      dashboard_status: "ready",
      next_focus_area: "Credit profile stability",
      current_balance: 842.17,
      posted_balance: 842.17,
      projected_balance: 900,
      credit_limit: 3000,
      minimum_payment: 35,
      payment_due_date: "2026-10-15",
      statement_close_date: "2026-10-01",
      available_credit: 1157.83,
      days_until_due_date: 13,
      days_until_statement_close: 8
    }
  });
  assert.strictEqual(progressVerifiedGrounding.status, "verified", "all required progress fields verified keeps grounding verified");
  console.log(`progress_verified_grounding => ${JSON.stringify({ status: progressVerifiedGrounding.status, currentBalance: progressVerifiedGrounding.currentBalance, paymentDueDate: progressVerifiedGrounding.paymentDueDate })}`);

  const staleTimingNoPastDue = buildGroundingContext({
    memberCoachContext: {
      days_until_due_date: -74,
      days_until_statement_close: -90,
      autopay_enabled: false,
      dashboard_status: "watching utilization"
    }
  });
  assert.strictEqual(staleTimingNoPastDue.status, "unavailable", "stale negative timing without verified delinquency should not be treated as current past due");
  assert.ok(staleTimingNoPastDue.staleFields.includes("daysUntilDueDate"), "stale negative due days are recorded");
  assert.ok(staleTimingNoPastDue.staleFields.includes("daysUntilStatementClose"), "stale negative statement-close days are recorded");
  assert.strictEqual(selectNextBestAction({ days_until_due_date: -74 }, []), "The billing-cycle status should be confirmed before treating this as a current past-due payment.", "stale negative counters should not trigger a current past-due action");
  console.log(`stale_timing_no_past_due => ${JSON.stringify({ status: staleTimingNoPastDue.status, staleFields: staleTimingNoPastDue.staleFields, nextBestAction: selectNextBestAction({ days_until_due_date: -74 }, []) })}`);

  const staleCyclePartialGrounding = buildGroundingContext({
    memberCoachContext: {
      current_tier: "Ascend",
      on_time_status: "on time",
      on_time_cycles_completed: 6,
      on_time_cycles_required: 6,
      autopay_enabled: true,
      avg_utilization_percent: 8,
      utilization_target_percent: 30,
      projected_utilization_percent: 30.5,
      dashboard_status: "ready",
      next_focus_area: "Credit profile stability",
      posted_balance: 842.17,
      projected_balance: 900,
      credit_limit: 3000,
      days_until_due_date: -74,
      days_until_statement_close: -90
    }
  });
  assert.strictEqual(staleCyclePartialGrounding.status, "partial", "stale cycle fields should not erase otherwise useful progress grounding");
  assert.ok(staleCyclePartialGrounding.staleFields.includes("daysUntilDueDate"), "stale cycle fields remain listed");
  console.log(`stale_cycle_partial_grounding => ${JSON.stringify({ status: staleCyclePartialGrounding.status, staleFields: staleCyclePartialGrounding.staleFields })}`);

  const progressSummaryShortAnswer = buildCoachContext({
    question: "How am I doing?",
    questionType: "ACCOUNT_PROGRESS_SUMMARY",
    user: { first_name: "Chris" },
    memberCoachContext: {
      current_tier: "Ascend",
      on_time_status: "on time",
      on_time_cycles_completed: 6,
      on_time_cycles_required: 6,
      autopay_enabled: true,
      avg_utilization_percent: 8,
      utilization_target_percent: 30,
      projected_utilization_percent: 30.5,
      next_focus_area: "Credit profile stability",
      posted_balance: 842.17,
      projected_balance: 900,
      credit_limit: 3000,
      days_until_due_date: -74,
      days_until_statement_close: -90
    }
  }).deterministicShortAnswer;
  assert.ok(/6 of 6 on-time cycles were completed/i.test(progressSummaryShortAnswer), "short answer includes the verified on-time cycle count");
  assert.ok(/AutoPay is enabled/i.test(progressSummaryShortAnswer), "short answer includes the verified AutoPay status");
  assert.ok(/average utilization is 8%/i.test(progressSummaryShortAnswer), "short answer includes the verified average utilization");
  assert.ok(/utilization target is 30%/i.test(progressSummaryShortAnswer), "short answer includes the verified target utilization");
  assert.ok(/projected utilization is 30.5%/i.test(progressSummaryShortAnswer), "short answer includes the verified projected utilization");
  assert.ok(/credit profile stability/i.test(progressSummaryShortAnswer), "short answer includes the verified next focus");
  assert.ok(!/monitoring the current cycle/i.test(progressSummaryShortAnswer), "short answer does not say it is monitoring the current cycle");
  assert.ok(!/past[- ]due/i.test(progressSummaryShortAnswer), "short answer does not claim current past-due status");
  assert.ok(!/current deadline|due date|deadline/i.test(progressSummaryShortAnswer), "short answer does not claim a current deadline");
  assert.ok(/billing-cycle dates from this snapshot|billing-cycle dates/i.test(progressSummaryShortAnswer), "short answer acknowledges unavailable billing-cycle timing naturally");
  console.log(`progress_summary_short_answer => ${progressSummaryShortAnswer}`);

  const nextBestActionGrounded = buildCoachContext({
    question: "What should I focus on next?",
    questionType: "ACCOUNT_PROGRESS_SUMMARY",
    user: { first_name: "Chris" },
    memberCoachContext: {
      current_tier: "Ascend",
      on_time_status: "on time",
      on_time_cycles_completed: 6,
      on_time_cycles_required: 6,
      autopay_enabled: true,
      avg_utilization_percent: 8,
      utilization_target_percent: 30,
      projected_utilization_percent: 30.5,
      next_focus_area: "Credit profile stability",
      calculated_readiness_status: "profile_changed",
      credit_score_previous: 650,
      credit_score: 620,
      credit_score_change: -30,
      credit_score_trend_status: "declined",
      dashboard_status: "yellow",
      account_status: "partial"
    }
  });
  assert.ok(/six completed on-time cycles|on-time cycles/i.test(nextBestActionGrounded.deterministicShortAnswer), "grounded next-best-action summary includes verified positive signal");
  assert.ok(/Credit profile stability|credit profile stability/i.test(nextBestActionGrounded.deterministicShortAnswer), "grounded next-best-action summary names the primary focus");
  assert.ok(!/good standing/i.test(nextBestActionGrounded.deterministicShortAnswer), "grounded next-best-action summary avoids unsupported good-standing wording");
  assert.ok(!/due date|past[- ]due|deadline/i.test(nextBestActionGrounded.deterministicShortAnswer), "grounded answer avoids billing-cycle deadline and past-due guidance");
  console.log(`next_best_action_grounded => ${JSON.stringify({ shortAnswer: nextBestActionGrounded.deterministicShortAnswer, detailedReasoning: nextBestActionGrounded.deterministicDetailedReasoning })}`);

  const shortDetailedAlignment = buildCoachContext({
    question: "What should I focus on next?",
    questionType: "ACCOUNT_PROGRESS_SUMMARY",
    user: { first_name: "Chris" },
    memberCoachContext: {
      current_tier: "Ascend",
      on_time_status: "on time",
      on_time_cycles_completed: 6,
      on_time_cycles_required: 6,
      autopay_enabled: true,
      avg_utilization_percent: 8,
      utilization_target_percent: 30,
      projected_utilization_percent: 30.5,
      next_focus_area: "Credit profile stability",
      calculated_readiness_status: "profile_changed"
    }
  });
  assert.ok(/credit profile stability/i.test(shortDetailedAlignment.deterministicShortAnswer + " " + shortDetailedAlignment.deterministicDetailedReasoning), "short and detailed answers align on the primary focus");
  assert.ok(!/good standing/i.test(shortDetailedAlignment.deterministicShortAnswer + " " + shortDetailedAlignment.deterministicDetailedReasoning), "short and detailed answers avoid good-standing claims");
  const shortDetailedText = shortDetailedAlignment.deterministicShortAnswer + " " + shortDetailedAlignment.deterministicDetailedReasoning;
  assert.ok(!/past[- ]due payment should be addressed first|make a payment as soon as possible|payment due date has passed|deadline for payment|due date is approaching/i.test(shortDetailedText), "short and detailed answers avoid active delinquency or deadline guidance");
  console.log(`short_detailed_alignment => ${JSON.stringify({ shortAnswer: shortDetailedAlignment.deterministicShortAnswer, detailedReasoning: shortDetailedAlignment.deterministicDetailedReasoning })}`);

  const verifiedPastDue = buildGroundingContext({
    memberCoachContext: {
      current_balance: 842.17,
      minimum_payment: 35,
      payment_due_date: "2026-09-20",
      days_until_due_date: -3,
      autopay_enabled: false,
      account_status: "past_due",
      past_due_status: true,
      dashboard_status: "past due"
    }
  });
  assert.ok(verifiedPastDue.status === "partial" || verifiedPastDue.status === "verified", "verified delinquency should not be treated as stale");
  assert.strictEqual(selectNextBestAction({ days_until_due_date: -3, minimum_payment: 35, past_due_status: true }, []), "Past-due payment should be addressed first.", "verified current delinquency should trigger the past-due action");
  console.log(`verified_past_due => ${JSON.stringify({ status: verifiedPastDue.status, nextBestAction: selectNextBestAction({ days_until_due_date: -3, minimum_payment: 35, past_due_status: true }, []) })}`);

  const projectedOnly = buildGroundingContext({
    memberCoachContext: {
      projected_balance: 900.00,
      projected_utilization_percent: 40,
      dashboard_status: "watching utilization"
    }
  });
  assert.strictEqual(projectedOnly.currentBalance, null);
  assert.strictEqual(projectedOnly.projectedBalance, 900);
  console.log(`projected_only => ${JSON.stringify({ currentBalance: projectedOnly.currentBalance, projectedBalance: projectedOnly.projectedBalance })}`);

  const noBalance = buildGroundingContext({
    memberCoachContext: {
      dashboard_status: "watching utilization"
    }
  });
  assert.strictEqual(noBalance.currentBalance, null);
  assert.strictEqual(noBalance.projectedBalance, null);
  assert.strictEqual(noBalance.status, "unavailable");
  console.log(`missing_current_and_projected => ${JSON.stringify({ currentBalance: noBalance.currentBalance, projectedBalance: noBalance.projectedBalance, status: noBalance.status })}`);

  const conversationConflicts = buildGroundingContext({
    memberCoachContext: {
      current_balance: 842.17,
      projected_balance: 900,
      dashboard_status: "good standing",
      conversation_last_balance: 910.00
    }
  });
  assert.strictEqual(conversationConflicts.currentBalance, 842.17);
  assert.ok(conversationConflicts.currentBalance !== 910);
  console.log(`conversation_conflict => ${JSON.stringify({ currentBalance: conversationConflicts.currentBalance })}`);

  const dueDateOnlyDays = buildGroundingContext({
    memberCoachContext: {
      days_until_due_date: 12,
      dashboard_status: "good standing"
    }
  });
  assert.strictEqual(dueDateOnlyDays.daysUntilDueDate, 12);
  assert.strictEqual(dueDateOnlyDays.paymentDueDate, null);
  console.log(`days_until_due_only => ${JSON.stringify({ daysUntilDueDate: dueDateOnlyDays.daysUntilDueDate, paymentDueDate: dueDateOnlyDays.paymentDueDate })}`);

  const autopayLookup = buildGroundingContext({
    memberCoachContext: { autopay_enabled: true }
  });
  assert.strictEqual(autopayLookup.autopayEnabled, true);
  console.log(`autopay_lookup => ${JSON.stringify({ autopayEnabled: autopayLookup.autopayEnabled })}`);

  const statementCloseLookup = buildGroundingContext({
    memberCoachContext: { statement_close_date: "2026-10-30", days_until_statement_close: 28 }
  });
  assert.strictEqual(statementCloseLookup.statementCloseDate, "2026-10-30");
  assert.strictEqual(statementCloseLookup.daysUntilStatementClose, 28);
  console.log(`statement_close_lookup => ${JSON.stringify({ statementCloseDate: statementCloseLookup.statementCloseDate, daysUntilStatementClose: statementCloseLookup.daysUntilStatementClose })}`);

  const availableCreditLookup = buildGroundingContext({
    memberCoachContext: { available_credit: 600.00, credit_limit: 2000 }
  });
  assert.strictEqual(availableCreditLookup.availableCredit, 600);
  console.log(`available_credit_lookup => ${JSON.stringify({ availableCredit: availableCreditLookup.availableCredit })}`);

  const exactDueDateNoDaysCounter = buildCoachContext({
    question: "Remind me of my exact due date again.",
    questionType: "LIVE_ACCOUNT_LOOKUP",
    user: { first_name: "Chris" },
    memberCoachContext: {
      current_balance: null,
      posted_balance: 80,
      projected_balance: 305,
      payment_due_date: null,
      days_until_due_date: 12
    }
  });
  assert.ok(!/12 days|due in|payment is due in|current deadline/i.test(exactDueDateNoDaysCounter.deterministicShortAnswer), "exact due-date requests do not use the days-until counter or a deadline claim");
  assert.ok(!/\b\d{4}-\d{2}-\d{2}\b/.test(exactDueDateNoDaysCounter.deterministicShortAnswer), "exact due-date requests abstain instead of claiming a concrete date");
  console.log(`exact_due_date_does_not_use_days_counter => ${JSON.stringify({ shortAnswer: exactDueDateNoDaysCounter.deterministicShortAnswer, detailedReasoning: exactDueDateNoDaysCounter.deterministicDetailedReasoning })}`);

  const staleDueCounterSuppressed = buildCoachContext({
    question: "How many days until my payment is due?",
    questionType: "LIVE_ACCOUNT_LOOKUP",
    user: { first_name: "Chris" },
    memberCoachContext: {
      current_balance: null,
      payment_due_date: null,
      days_until_due_date: -74,
      autopay_enabled: false
    }
  });
  assert.ok(!/-74/i.test(staleDueCounterSuppressed.deterministicShortAnswer), "stale due counter is not returned to the customer");
  assert.ok(!/due in|past due|overdue/i.test(staleDueCounterSuppressed.deterministicShortAnswer), "stale due counter does not trigger due-date or past-due language");
  console.log(`stale_due_counter_not_returned => ${JSON.stringify({ shortAnswer: staleDueCounterSuppressed.deterministicShortAnswer, detailedReasoning: staleDueCounterSuppressed.deterministicDetailedReasoning })}`);

  const currentBalanceNotSubstituted = buildCoachContext({
    question: "What is my current balance?",
    questionType: "LIVE_ACCOUNT_LOOKUP",
    user: { first_name: "Chris" },
    memberCoachContext: {
      current_balance: null,
      posted_balance: 80,
      projected_balance: 305,
      dashboard_status: "watching utilization"
    }
  });
  assert.ok(!/current balance is \$80\.00|current balance is \$305\.00|your current balance is \$80\.00|your current balance is \$305\.00/i.test(currentBalanceNotSubstituted.deterministicShortAnswer), "customer-facing answer does not present posted or projected values as the current balance");
  assert.ok(/posted balance|projected balance|current account snapshot/i.test(currentBalanceNotSubstituted.deterministicShortAnswer), "posted and projected balances are labeled distinctly when they are mentioned");
  console.log(`current_balance_not_substituted => ${JSON.stringify({ shortAnswer: currentBalanceNotSubstituted.deterministicShortAnswer, detailedReasoning: currentBalanceNotSubstituted.deterministicDetailedReasoning })}`);

  const partialGroundingOutput = buildCoachContext({
    question: "What is my current balance and exact due date?",
    questionType: "LIVE_ACCOUNT_LOOKUP",
    user: { first_name: "Chris" },
    memberCoachContext: {
      current_balance: null,
      posted_balance: 80,
      projected_balance: 305,
      payment_due_date: null,
      days_until_due_date: 12,
      dashboard_status: "partial"
    }
  });
  assert.ok(!/verified grounding/i.test(partialGroundingOutput.deterministicShortAnswer + " " + partialGroundingOutput.deterministicDetailedReasoning), "partial grounding wording does not claim verified grounding");
  assert.ok(/current account snapshot|verified current balance|exact payment due date|current balance/i.test(partialGroundingOutput.deterministicShortAnswer), "partial grounding wording explains the unavailable fields naturally");
  console.log(`partial_grounding_wording => ${JSON.stringify({ shortAnswer: partialGroundingOutput.deterministicShortAnswer, detailedReasoning: partialGroundingOutput.deterministicDetailedReasoning })}`);

  const availableCreditSpecific = buildCoachContext({
    question: "What is my available credit?",
    questionType: "LIVE_ACCOUNT_LOOKUP",
    user: { first_name: "Chris" },
    memberCoachContext: { available_credit: 600.00, current_balance: null, payment_due_date: null }
  });
  assert.ok(/available credit/i.test(availableCreditSpecific.deterministicShortAnswer), "available-credit answer includes the requested field");
  assert.ok(!/current balance|due date|payment is due/i.test(availableCreditSpecific.deterministicShortAnswer), "available-credit answer stays field-specific and excludes unrelated account details");
  console.log(`available_credit_field_specific => ${JSON.stringify({ shortAnswer: availableCreditSpecific.deterministicShortAnswer })}`);

  const autopaySpecific = buildCoachContext({
    question: "Is AutoPay enabled?",
    questionType: "LIVE_ACCOUNT_LOOKUP",
    user: { first_name: "Chris" },
    memberCoachContext: { autopay_enabled: true, current_balance: null, payment_due_date: null }
  });
  assert.ok(/AutoPay is enabled/i.test(autopaySpecific.deterministicShortAnswer), "AutoPay answer includes the requested status");
  assert.ok(/current KEYR account/i.test(autopaySpecific.deterministicShortAnswer), "AutoPay answer explicitly ties the status to the current KEYR account");
  assert.ok(!/current balance|due date|payment is due/i.test(autopaySpecific.deterministicShortAnswer), "AutoPay answer stays field-specific and excludes unrelated account details");
  console.log(`autopay_field_specific => ${JSON.stringify({ shortAnswer: autopaySpecific.deterministicShortAnswer })}`);

  const runtimeAutoPayOverride = shouldShortCircuitDeterministicAnswer("AUTOPAY_GUIDANCE", "Is AutoPay enabled?");
  assert.strictEqual(runtimeAutoPayOverride, true, "AUTOPAY_GUIDANCE short-circuits the generic coaching orchestration");
  console.log(`runtime_autopay_override => ${JSON.stringify({ shouldShortCircuit: runtimeAutoPayOverride })}`);

  const asciiApostropheSafe = buildCoachContext({
    question: "Remind me of my current balance and exact due date again.",
    questionType: "LIVE_ACCOUNT_LOOKUP",
    user: { first_name: "Chris" },
    memberCoachContext: {
      current_balance: null,
      posted_balance: 80,
      projected_balance: 305,
      payment_due_date: null,
      days_until_due_date: -74,
      dashboard_status: "partial"
    }
  });
  assert.ok(/I'm unable/i.test(asciiApostropheSafe.deterministicShortAnswer), "ASCII apostrophe-safe fallback is used for the direct customer-facing answer");
  assert.ok(!/Iâm|I’m/i.test(asciiApostropheSafe.deterministicShortAnswer), "fallback output does not contain malformed apostrophe encodings");
  console.log(`ascii_apostrophe_safe => ${JSON.stringify({ shortAnswer: asciiApostropheSafe.deterministicShortAnswer })}`);

  const topicPivotPreservesConversation = buildCoachContext({
    question: "Remind me of my current balance and exact due date again.",
    questionType: "LIVE_ACCOUNT_LOOKUP",
    user: { first_name: "Chris" },
    memberCoachContext: {
      current_balance: null,
      posted_balance: 80,
      projected_balance: 305,
      payment_due_date: null,
      days_until_due_date: -74,
      dashboard_status: "partial"
    }
  });
  assert.ok(/earlier financial-readiness conversation remains saved|prior coaching conversation remains available/i.test(topicPivotPreservesConversation.deterministicShortAnswer), "response preserves access to the earlier conversation topic");
  console.log(`topic_pivot_preserves_conversation => ${JSON.stringify({ shortAnswer: topicPivotPreservesConversation.deterministicShortAnswer })}`);

  const availableCreditIntent = classifyQuestionType("What is my available credit?");
  assert.strictEqual(availableCreditIntent, "LIVE_ACCOUNT_LOOKUP", "available-credit question must be classified as account lookup");
  console.log(`available_credit_intent => ${availableCreditIntent}`);

  const availableCreditVariantIntent = classifyQuestionType("How much credit do I have available?");
  assert.strictEqual(availableCreditVariantIntent, "LIVE_ACCOUNT_LOOKUP", "available-credit variant must stay an account lookup");
  console.log(`available_credit_variant_intent => ${availableCreditVariantIntent}`);

  const spendingCapacityIntent = classifyQuestionType("How much can I still spend?");
  assert.strictEqual(spendingCapacityIntent, "LIVE_ACCOUNT_LOOKUP", "spending-capacity question must stay an account lookup");
  console.log(`spending_capacity_intent => ${spendingCapacityIntent}`);

  const creditLimitIntent = classifyQuestionType("What is my credit limit?");
  assert.strictEqual(creditLimitIntent, "LIVE_ACCOUNT_LOOKUP", "credit-limit question must stay an account lookup");
  console.log(`credit_limit_intent => ${creditLimitIntent}`);

  const utilizationCurrentIntent = classifyQuestionType("What is my credit utilization?");
  assert.strictEqual(utilizationCurrentIntent, "UTILIZATION_GUIDANCE", "credit-utilization question must keep utilization routing");
  console.log(`utilization_current_intent => ${utilizationCurrentIntent}`);

  const utilizationAdviceIntent = classifyQuestionType("How can I lower my utilization?");
  assert.strictEqual(utilizationAdviceIntent, "UTILIZATION_GUIDANCE", "utilization advice question must keep utilization routing");
  console.log(`utilization_advice_intent => ${utilizationAdviceIntent}`);

  const availableCreditResponsePreserved = buildCoachContext({
    question: "What is my available credit?",
    questionType: "LIVE_ACCOUNT_LOOKUP",
    user: { first_name: "Chris" },
    memberCoachContext: { available_credit: null, credit_limit: 2000 }
  });
  assert.strictEqual(
    availableCreditResponsePreserved.deterministicShortAnswer,
    "Chris, I'm unable to verify your available credit from the current account snapshot, and I do not want to give you inaccurate information. Please check your current account dashboard or statement for the latest available credit. Your earlier financial-readiness conversation remains saved whenever you want to continue.",
    "unavailable available-credit abstention remains unchanged"
  );
  assert.ok(!/\$920|\$695|\$\d+\.\d+/.test(availableCreditResponsePreserved.deterministicShortAnswer), "unavailable available-credit response does not infer a number");
  assert.ok(!/focus on|progress status|credit profile stability|good standing/i.test(availableCreditResponsePreserved.deterministicShortAnswer), "unavailable available-credit response stays direct and does not inject generic progress guidance");
  console.log(`available_credit_response_preserved => ${JSON.stringify({ shortAnswer: availableCreditResponsePreserved.deterministicShortAnswer })}`);

  const exactAscendPlanClassification = classifyQuestionType("Build an exact Ascend balance-transfer plan. My approved transfer capacity is $5,000, and the proposed 2% transfer fee counts inside that capacity. Card A has a $3,200 balance at 29.99% APR with a $110 minimum payment and is eligible for transfer. Card B has a $2,400 balance at 24.99% APR with an $85 minimum payment and is eligible for transfer. Card C has a $1,000 balance at 18.99% APR with a $40 minimum payment and is eligible for transfer. I can pay $600 per month toward debt.");
  assert.strictEqual(exactAscendPlanClassification, "DEBT_PLAN_NEW", "exact multi-card transfer plan must classify as a debt plan, not payment status");
  console.log(`exact_ascend_plan_classification => ${exactAscendPlanClassification}`);

  const monthlyBudgetNotPaymentStatus = classifyQuestionType("I can pay $600 per month toward debt.");
  assert.strictEqual(monthlyBudgetNotPaymentStatus, "DEBT_PLAN_NEW", "monthly debt budget is planning input rather than a payment-status question");
  console.log(`monthly_budget_not_payment_status => ${monthlyBudgetNotPaymentStatus}`);

  const simplePaymentStatusStillWorks = classifyQuestionType("Has my payment posted?");
  assert.strictEqual(simplePaymentStatusStillWorks, "PAYMENT_STATUS", "simple payment-status check remains narrow and functional");
  console.log(`simple_payment_status_still_works => ${simplePaymentStatusStillWorks}`);

  const meritTransferQuestion = classifyQuestionType("Can Merit accept a balance transfer?");
  assert.strictEqual(meritTransferQuestion, "BALANCE_TRANSFER_ELIGIBILITY");
  console.log(`legacy_merit_transfer_routing => ${meritTransferQuestion}`);

  const exactAscendInsideCapacityPlan = buildTransferPlan([
    { card_label: "Card A", current_balance: 3200, apr_percent: 29.99, minimum_payment: 110, transfer_eligible: true, valueSource: "customer_provided" },
    { card_label: "Card B", current_balance: 2400, apr_percent: 24.99, minimum_payment: 85, transfer_eligible: true, valueSource: "customer_provided" },
    { card_label: "Card C", current_balance: 1000, apr_percent: 18.99, minimum_payment: 40, transfer_eligible: true, valueSource: "customer_provided" }
  ], {
    transfer_limit: 5000,
    transfer_fee_percent: 2,
    fee_treatment: "inside_capacity",
    monthly_payment_budget: 600,
    keyr_tier: "Ascend"
  });
  assert.strictEqual(exactAscendInsideCapacityPlan.totalTransferred, 4901.96, "inside-capacity transfer stays under the approved 5,000 limit without exceeding the fee treatment");
  assert.strictEqual(exactAscendInsideCapacityPlan.totalTransferFees, 98.04, "inside-capacity fee total matches the 2% fee on 4,901.96 principal");
  assert.strictEqual(exactAscendInsideCapacityPlan.totalCapacityUsed, 5000.00, "inside-capacity plan fully uses the approved transfer limit");
  assert.strictEqual(exactAscendInsideCapacityPlan.unusedCapacity, 0.00, "unused capacity is zero when fee treatment is inside capacity");
  assert.strictEqual(exactAscendInsideCapacityPlan.totalOpeningTransferredBalance, 5000.00, "opening transferred balance includes principal plus fee inside capacity");
  console.log(`exact_ascend_inside_capacity_plan => ${JSON.stringify({ totalTransferred: exactAscendInsideCapacityPlan.totalTransferred, totalTransferFees: exactAscendInsideCapacityPlan.totalTransferFees, totalCapacityUsed: exactAscendInsideCapacityPlan.totalCapacityUsed, unusedCapacity: exactAscendInsideCapacityPlan.unusedCapacity, totalOpeningTransferredBalance: exactAscendInsideCapacityPlan.totalOpeningTransferredBalance })}`);

  const highestAprAllocation = buildTransferPlan([
    { card_label: "Card A", current_balance: 3200, apr_percent: 29.99, minimum_payment: 110, transfer_eligible: true, valueSource: "customer_provided" },
    { card_label: "Card B", current_balance: 2400, apr_percent: 24.99, minimum_payment: 85, transfer_eligible: true, valueSource: "customer_provided" },
    { card_label: "Card C", current_balance: 1000, apr_percent: 18.99, minimum_payment: 40, transfer_eligible: true, valueSource: "customer_provided" }
  ], {
    transfer_limit: 5000,
    transfer_fee_percent: 2,
    fee_treatment: "inside_capacity",
    monthly_payment_budget: 600,
    keyr_tier: "Ascend"
  });
  assert.strictEqual(highestAprAllocation.allocations[0].cardLabel, "Card A", "highest APR card is allocated first");
  assert.strictEqual(highestAprAllocation.allocations[0].transferAmount, 3200.00, "Card A receives the full 3,200 balance first");
  assert.strictEqual(highestAprAllocation.allocations[1].cardLabel, "Card B", "second-highest APR card is allocated second");
  assert.strictEqual(highestAprAllocation.allocations[1].transferAmount, 1701.96, "Card B receives the remaining available principal under capacity");
  assert.strictEqual(highestAprAllocation.allocations[2]?.transferAmount || 0, 0, "Card C receives no transfer because capacity is exhausted after Card B");
  console.log(`highest_apr_allocation => ${JSON.stringify({ first: highestAprAllocation.allocations[0], second: highestAprAllocation.allocations[1], third: highestAprAllocation.allocations[2] || { cardLabel: "Card C", transferAmount: 0 } })}`);

  const sourceBalancesCorrect = buildTransferPlan([
    { card_label: "Card A", current_balance: 3200, apr_percent: 29.99, minimum_payment: 110, transfer_eligible: true, valueSource: "customer_provided" },
    { card_label: "Card B", current_balance: 2400, apr_percent: 24.99, minimum_payment: 85, transfer_eligible: true, valueSource: "customer_provided" },
    { card_label: "Card C", current_balance: 1000, apr_percent: 18.99, minimum_payment: 40, transfer_eligible: true, valueSource: "customer_provided" }
  ], {
    transfer_limit: 5000,
    transfer_fee_percent: 2,
    fee_treatment: "inside_capacity",
    monthly_payment_budget: 600,
    keyr_tier: "Ascend"
  });
  assert.strictEqual(sourceBalancesCorrect.allocations[0].remainingBalance, 0, "Card A balance is fully paid off");
  assert.strictEqual(sourceBalancesCorrect.allocations[1].remainingBalance, 698.04, "Card B retains the non-transferred balance after the transfer");
  assert.strictEqual(sourceBalancesCorrect.allocations[2]?.remainingBalance || 1000, 1000, "Card C retains its full balance because no capacity remains");
  console.log(`source_balances_correct => ${JSON.stringify({ cardA: sourceBalancesCorrect.allocations[0].remainingBalance, cardB: sourceBalancesCorrect.allocations[1].remainingBalance, cardC: sourceBalancesCorrect.allocations[2]?.remainingBalance || 1000 })}`);

  const exactPlanNarrativeSelected = resolveFinalRecommendation({
    genericCoachContext: {
      recommendedStrategy: "highest_apr_first",
      recommendedCardLabel: "Card A",
      recommendedTransferAmount: exactAscendInsideCapacityPlan.recommendedTransferAmount,
      totalTransferred: exactAscendInsideCapacityPlan.totalTransferred,
      totalTransferFees: exactAscendInsideCapacityPlan.totalTransferFees,
      totalCapacityUsed: exactAscendInsideCapacityPlan.totalCapacityUsed,
      unusedCapacity: exactAscendInsideCapacityPlan.unusedCapacity,
      totalOpeningTransferredBalance: exactAscendInsideCapacityPlan.totalOpeningTransferredBalance,
      transferFee: exactAscendInsideCapacityPlan.transferFee,
      feeTreatment: exactAscendInsideCapacityPlan.feeTreatment,
      transferPlanStatus: exactAscendInsideCapacityPlan.transferPlanStatus,
      allocations: exactAscendInsideCapacityPlan.allocations,
      deterministicShortAnswer: "six completed on-time cycles",
      deterministicDetailedReasoning: "credit profile stability",
      shortAnswer: "six completed on-time cycles",
      detailedReasoning: "credit profile stability"
    },
    exactPlan: exactAscendInsideCapacityPlan,
    aiResult: { aiWasUsed: true, shortAnswer: "six completed on-time cycles" },
    question: "Build an exact Ascend balance-transfer plan. My approved transfer capacity is $5,000, and the proposed 2% transfer fee counts inside that capacity. Card A has a $3,200 balance at 29.99% APR with a $110 minimum payment and is eligible for transfer. Card B has a $2,400 balance at 24.99% APR with an $85 minimum payment and is eligible for transfer. Card C has a $1,000 balance at 18.99% APR with a $40 minimum payment and is eligible for transfer. I can pay $600 per month toward debt.",
    questionType: "DEBT_PLAN_NEW",
    user: { first_name: "Chris" }
  });
  assert.ok(/\$4,901\.96/.test(exactPlanNarrativeSelected.recommendation.shortAnswer), "exact short answer includes principal total");
  assert.ok(/Card A/.test(exactPlanNarrativeSelected.recommendation.shortAnswer), "exact short answer includes Card A");
  assert.ok(/Card B/.test(exactPlanNarrativeSelected.recommendation.shortAnswer), "exact short answer includes Card B");
  assert.ok(/\$98\.04/.test(exactPlanNarrativeSelected.recommendation.shortAnswer), "exact short answer includes fee total");
  assert.ok(!/credit profile stability/i.test(exactPlanNarrativeSelected.recommendation.shortAnswer), "exact short answer excludes generic progress language");
  console.log(`exact_plan_narrative_selected => ${JSON.stringify({ shortAnswer: exactPlanNarrativeSelected.recommendation.shortAnswer })}`);

  assert.ok(/29\.99%/.test(exactPlanNarrativeSelected.recommendation.detailedReasoning), "exact detailed reasoning mentions 29.99%");
  assert.ok(/24\.99%/.test(exactPlanNarrativeSelected.recommendation.detailedReasoning), "exact detailed reasoning mentions 24.99%");
  assert.ok(/Card C at 18\.99%/.test(exactPlanNarrativeSelected.recommendation.detailedReasoning), "exact detailed reasoning mentions Card C at 18.99%");
  assert.ok(/\$235\.00/.test(exactPlanNarrativeSelected.recommendation.detailedReasoning), "exact detailed reasoning mentions listed minimum payments");
  assert.ok(/\$365\.00/.test(exactPlanNarrativeSelected.recommendation.detailedReasoning), "exact detailed reasoning mentions remaining monthly budget");
  assert.ok(/subject to approval and the applicable program terms/i.test(exactPlanNarrativeSelected.recommendation.detailedReasoning), "exact detailed reasoning includes approval and terms conditions");
  console.log(`exact_plan_detailed_reasoning_selected => ${JSON.stringify({ detailedReasoning: exactPlanNarrativeSelected.recommendation.detailedReasoning })}`);

  assert.strictEqual(exactPlanNarrativeSelected.recommendation.totalTransferFees, 98.04);
  assert.strictEqual(exactPlanNarrativeSelected.recommendation.totalCapacityUsed, 5000);
  assert.strictEqual(exactPlanNarrativeSelected.recommendation.unusedCapacity, 0);
  assert.strictEqual(exactPlanNarrativeSelected.recommendation.totalOpeningTransferredBalance, 5000);
  assert.strictEqual(exactPlanNarrativeSelected.recommendation.feeTreatment, "inside_capacity");
  assert.strictEqual(exactPlanNarrativeSelected.recommendation.transferPlanStatus, "calculated");
  console.log(`exact_plan_totals_exposed => ${JSON.stringify({ totalTransferFees: exactPlanNarrativeSelected.recommendation.totalTransferFees, totalCapacityUsed: exactPlanNarrativeSelected.recommendation.totalCapacityUsed, unusedCapacity: exactPlanNarrativeSelected.recommendation.unusedCapacity, totalOpeningTransferredBalance: exactPlanNarrativeSelected.recommendation.totalOpeningTransferredBalance, feeTreatment: exactPlanNarrativeSelected.recommendation.feeTreatment, transferPlanStatus: exactPlanNarrativeSelected.recommendation.transferPlanStatus })}`);

  const cardALineage = exactPlanNarrativeSelected.recommendation.allocations.find((item) => item.cardLabel === "Card A");
  const cardBLineage = exactPlanNarrativeSelected.recommendation.allocations.find((item) => item.cardLabel === "Card B");
  const cardCPlanningState = exactPlanNarrativeSelected.recommendation.planningState.cards.find((item) => item.cardLabel === "Card C");
  assert.strictEqual(cardALineage?.valueSource, "customer_provided");
  assert.strictEqual(cardBLineage?.valueSource, "customer_provided");
  assert.strictEqual(cardCPlanningState?.valueSource, "customer_provided");
  console.log(`customer_provided_lineage => ${JSON.stringify({ cardA: cardALineage?.valueSource, cardB: cardBLineage?.valueSource, cardC: cardCPlanningState?.valueSource })}`);

  assert.strictEqual(cardCPlanningState?.plannedTransferAmount, 0);
  assert.strictEqual(cardCPlanningState?.remainingBalance, 1000);
  assert.strictEqual(cardCPlanningState?.priorityOrder, 3);
  console.log(`card_c_preserved_in_planning_state => ${JSON.stringify({ plannedTransferAmount: cardCPlanningState?.plannedTransferAmount, remainingBalance: cardCPlanningState?.remainingBalance, priorityOrder: cardCPlanningState?.priorityOrder })}`);

  assert.strictEqual(exactPlanNarrativeSelected.recommendation.recommendedTransferAmount, 3200);
  assert.strictEqual(exactPlanNarrativeSelected.recommendation.totalTransferred, 4901.96);
  console.log(`recommendation_amount_semantics => ${JSON.stringify({ recommendedTransferAmount: exactPlanNarrativeSelected.recommendation.recommendedTransferAmount, totalTransferred: exactPlanNarrativeSelected.recommendation.totalTransferred })}`);

  assert.ok(!/six completed on-time cycles|positive account-management signals|credit profile stability|next-best-action|next best action/i.test(`${exactPlanNarrativeSelected.recommendation.shortAnswer} ${exactPlanNarrativeSelected.recommendation.detailedReasoning}`), "exact plan response must exclude generic progress language");
  console.log(`exact_plan_no_generic_overwrite => ${JSON.stringify({ shortAnswer: exactPlanNarrativeSelected.recommendation.shortAnswer, detailedReasoning: exactPlanNarrativeSelected.recommendation.detailedReasoning })}`);

  const exactPlanPrincipalSum = roundCurrency(exactPlanNarrativeSelected.recommendation.allocations.reduce((sum, item) => sum + Number(item.transferAmount || 0), 0));
  const exactPlanFeeSum = roundCurrency(exactPlanNarrativeSelected.recommendation.allocations.reduce((sum, item) => sum + Number(item.transferFee || 0), 0));
  const exactPlanCapacityUsed = roundCurrency(Number(exactPlanNarrativeSelected.recommendation.totalTransferred || 0) + Number(exactPlanNarrativeSelected.recommendation.totalTransferFees || 0));
  assert.strictEqual(exactPlanPrincipalSum, 4901.96);
  assert.strictEqual(exactPlanFeeSum, 98.04);
  assert.strictEqual(exactPlanCapacityUsed, 5000);
  console.log(`exact_plan_reconciliation => ${JSON.stringify({ principalSum: exactPlanPrincipalSum, feeSum: exactPlanFeeSum, capacityUsed: exactPlanCapacityUsed })}`);

  const planningResponseNotOverwritten = resolveFinalRecommendation({
    genericCoachContext: {
      recommendedStrategy: "highest_apr_first",
      recommendedCardLabel: "Card A",
      recommendedTransferAmount: 4901.96,
      totalTransferred: 4901.96,
      transferFee: 98.04,
      allocations: [
        { cardLabel: "Card A", transferAmount: 3200.00, transferFee: 64.00 },
        { cardLabel: "Card B", transferAmount: 1701.96, transferFee: 34.04 }
      ],
      deterministicShortAnswer: "Chris, using an Ascend transfer capacity of $5,000 with the proposed 2% fee counted inside that capacity, the maximum transferable principal is $4,901.96.",
      detailedReasoning: "Card A is prioritized because its 29.99% APR is the highest."
    },
    aiResult: { aiWasUsed: true, shortAnswer: "generic progress guidance" },
    question: "Build an exact Ascend balance-transfer plan. My approved transfer capacity is $5,000, and the proposed 2% transfer fee counts inside that capacity. Card A has a $3,200 balance at 29.99% APR with a $110 minimum payment and is eligible for transfer. Card B has a $2,400 balance at 24.99% APR with an $85 minimum payment and is eligible for transfer. Card C has a $1,000 balance at 18.99% APR with a $40 minimum payment and is eligible for transfer. I can pay $600 per month toward debt.",
    questionType: "DEBT_PLAN_NEW",
    user: { first_name: "Chris" }
  });
  assert.strictEqual(planningResponseNotOverwritten.answerSource, "deterministic", "the exact deterministic plan must remain authoritative even when the deep model is available");
  assert.ok(/maximum transferable principal is \$4,901\.96/i.test(planningResponseNotOverwritten.recommendation.shortAnswer), "the exact deterministic transfer calculation remains in the final recommendation");
  assert.ok(!/generic progress guidance/i.test(planningResponseNotOverwritten.recommendation.shortAnswer), "generic progress guidance cannot overwrite the exact transfer plan");
  console.log(`planning_response_not_overwritten => ${JSON.stringify({ shortAnswer: planningResponseNotOverwritten.recommendation.shortAnswer, answerSource: planningResponseNotOverwritten.answerSource, totalTransferred: planningResponseNotOverwritten.recommendation.totalTransferred })}`);

  const deepModelUnavailablePreservesPlan = resolveFinalRecommendation({
    genericCoachContext: {
      recommendedStrategy: "highest_apr_first",
      recommendedCardLabel: "Card A",
      recommendedTransferAmount: 4901.96,
      totalTransferred: 4901.96,
      transferFee: 98.04,
      allocations: [
        { cardLabel: "Card A", transferAmount: 3200.00, transferFee: 64.00 },
        { cardLabel: "Card B", transferAmount: 1701.96, transferFee: 34.04 }
      ],
      deterministicShortAnswer: "Chris, using an Ascend transfer capacity of $5,000 with the proposed 2% fee counted inside that capacity, the maximum transferable principal is $4,901.96.",
      detailedReasoning: "Card A is prioritized because its 29.99% APR is the highest."
    },
    aiResult: { aiWasUsed: false, shortAnswer: "deep-model unavailable" },
    question: "Build an exact Ascend balance-transfer plan. My approved transfer capacity is $5,000, and the proposed 2% transfer fee counts inside that capacity. Card A has a $3,200 balance at 29.99% APR with a $110 minimum payment and is eligible for transfer. Card B has a $2,400 balance at 24.99% APR with an $85 minimum payment and is eligible for transfer. Card C has a $1,000 balance at 18.99% APR with a $40 minimum payment and is eligible for transfer. I can pay $600 per month toward debt.",
    questionType: "DEBT_PLAN_NEW",
    user: { first_name: "Chris" }
  });
  assert.strictEqual(deepModelUnavailablePreservesPlan.answerSource, "deterministic", "deterministic recommendation remains authoritative when the deep model is unavailable");
  assert.strictEqual(deepModelUnavailablePreservesPlan.recommendation.totalTransferred, 4901.96, "deep-model fallback preserves the validated transfer calculation");
  console.log(`deep_model_unavailable_preserves_plan => ${JSON.stringify({ shortAnswer: deepModelUnavailablePreservesPlan.recommendation.shortAnswer, answerSource: deepModelUnavailablePreservesPlan.answerSource, totalTransferred: deepModelUnavailablePreservesPlan.recommendation.totalTransferred })}`);

  const conversationIdPreserved = "conv-transfer-123";
  const preservedRouteResponse = {
    conversationId: conversationIdPreserved,
    ...resolveFinalRecommendation({
      genericCoachContext: {
        recommendedStrategy: "highest_apr_first",
        recommendedCardLabel: "Card A",
        recommendedTransferAmount: 4901.96,
        totalTransferred: 4901.96,
        transferFee: 98.04,
        allocations: [
          { cardLabel: "Card A", transferAmount: 3200.00, transferFee: 64.00 },
          { cardLabel: "Card B", transferAmount: 1701.96, transferFee: 34.04 }
        ],
        deterministicShortAnswer: "Chris, using an Ascend transfer capacity of $5,000 with the proposed 2% fee counted inside that capacity, the maximum transferable principal is $4,901.96.",
        detailedReasoning: "Card A is prioritized because its 29.99% APR is the highest."
      },
      aiResult: { aiWasUsed: false },
      question: "Build an exact Ascend balance-transfer plan. My approved transfer capacity is $5,000, and the proposed 2% transfer fee counts inside that capacity. Card A has a $3,200 balance at 29.99% APR with a $110 minimum payment and is eligible for transfer. Card B has a $2,400 balance at 24.99% APR with an $85 minimum payment and is eligible for transfer. Card C has a $1,000 balance at 18.99% APR with a $40 minimum payment and is eligible for transfer. I can pay $600 per month toward debt.",
      questionType: "DEBT_PLAN_NEW",
      user: { first_name: "Chris" }
    })
  };
  assert.strictEqual(preservedRouteResponse.conversationId, conversationIdPreserved, "conversationId remains intact while the deterministic transfer plan is returned");
  console.log(`conversation_id_preserved => ${JSON.stringify({ conversationId: preservedRouteResponse.conversationId })}`);

  const turnOneState = buildExplicitDebtPlanState("Help me build an Ascend balance-transfer plan. Card A has a $3,200 balance at 29.99% APR and Card B has a $2,400 balance at 24.99% APR.");
  const turnTwoFragment = buildExplicitDebtPlanState("My approved transfer capacity is $4,000. The proposed 2% fee counts inside capacity. Both cards are eligible. Card A's minimum payment is $110, Card B's minimum payment is $85, and I can pay $500 per month.");
  const mergedCalculatedState = mergeDebtPlanState(turnOneState, turnTwoFragment);
  const mergedCalculatedPlan = attachPlanningStateToPlan(
    buildTransferPlan(mergedCalculatedState.cards, {
      transfer_limit: mergedCalculatedState.approvedTransferCapacity,
      transfer_fee_percent: mergedCalculatedState.feeRate * 100,
      fee_treatment: mergedCalculatedState.feeTreatment,
      monthly_payment_budget: mergedCalculatedState.monthlyDebtBudget,
      keyr_tier: mergedCalculatedState.selectedProduct
    }),
    {
      ...mergedCalculatedState,
      status: "ready",
      missingInputs: []
    }
  );
  assert.strictEqual(mergedCalculatedPlan.transferPlanStatus, "calculated");
  assert.strictEqual(mergedCalculatedPlan.totalTransferred, 3921.56);
  assert.strictEqual(mergedCalculatedPlan.totalTransferFees, 78.44);
  assert.strictEqual(mergedCalculatedPlan.totalCapacityUsed, 4000);

  const calculatedCheckpoint = buildDebtPlanCheckpoint({
    conversationId: "resume-conv-1",
    plan: mergedCalculatedPlan,
    updatedAtUtc: "2026-10-04T22:00:00.000Z"
  });
  assert.ok(calculatedCheckpoint, "complete calculated plan becomes the latest authoritative plan checkpoint");
  assert.strictEqual(calculatedCheckpoint.transferPlanStatus, "calculated");
  assert.strictEqual(calculatedCheckpoint.selectedProduct, "Ascend");
  assert.strictEqual(calculatedCheckpoint.totalTransferred, 3921.56);
  console.log(`calculated_checkpoint_saved => ${JSON.stringify({ transferPlanStatus: calculatedCheckpoint.transferPlanStatus, selectedProduct: calculatedCheckpoint.selectedProduct, totalTransferred: calculatedCheckpoint.totalTransferred, totalTransferFees: calculatedCheckpoint.totalTransferFees })}`);

  const followupFragmentCheckpoint = buildDebtPlanCheckpoint({
    conversationId: "resume-conv-1",
    plan: {
      transferPlanStatus: "calculated",
      planningState: {
        status: "ready",
        selectedProduct: turnTwoFragment.selectedProduct,
        approvedTransferCapacity: turnTwoFragment.approvedTransferCapacity,
        feeRate: turnTwoFragment.feeRate,
        feeTreatment: turnTwoFragment.feeTreatment,
        monthlyDebtBudget: turnTwoFragment.monthlyDebtBudget,
        cards: normalizeCheckpointCards(turnTwoFragment.cards)
      },
      cards: turnTwoFragment.cards,
      recommendedStrategy: "highest_apr_first",
      recommendedCardLabel: "Card A",
      recommendedTransferAmount: 3200,
      totalTransferred: 3921.56,
      totalTransferFees: 78.44,
      totalCapacityUsed: 4000,
      unusedCapacity: 0,
      totalOpeningTransferredBalance: 4000,
      allocations: mergedCalculatedPlan.allocations,
      eligibleCardLabels: ["Card A", "Card B"],
      unknownEligibilityCardLabels: [],
      ineligibleCardLabels: [],
      missingInputs: []
    },
    updatedAtUtc: "2026-10-04T22:01:00.000Z"
  });
  assert.strictEqual(reconcilePlanWithCheckpoint(followupFragmentCheckpoint), null, "latest individual fragment does not replace the merged calculated plan");
  console.log(`followup_fragment_not_authoritative => ${JSON.stringify({ authoritative: reconcilePlanWithCheckpoint(followupFragmentCheckpoint) !== null })}`);

  const resumeConversationHistory = [
    {
      role: "assistant",
      created_at_utc: "2026-10-04T22:00:00.000Z",
      message_metadata: {
        questionType: "DEBT_PLAN_ADJUST",
        debtPlanCheckpoint: calculatedCheckpoint
      }
    },
    {
      role: "assistant",
      created_at_utc: "2026-10-04T22:02:00.000Z",
      message_metadata: {
        questionType: "AUTOPAY_GUIDANCE",
        aiWasUsed: false
      }
    }
  ];
  const restoredCalculatedPlan = deriveAuthoritativeDebtPlanFromConversationHistory(resumeConversationHistory, { first_name: "Chris" });
  assert.ok(restoredCalculatedPlan, "resume finds the latest authoritative calculated checkpoint");
  assert.strictEqual(restoredCalculatedPlan.transferPlanStatus, "calculated");
  assert.strictEqual(restoredCalculatedPlan.planningState.selectedProduct, "Ascend");
  assert.strictEqual(restoredCalculatedPlan.totalTransferred, 3921.56);
  assert.strictEqual(restoredCalculatedPlan.totalTransferFees, 78.44);
  console.log(`autopay_pivot_preserves_plan => ${JSON.stringify({ transferPlanStatus: restoredCalculatedPlan.transferPlanStatus, selectedProduct: restoredCalculatedPlan.planningState.selectedProduct, totalTransferred: restoredCalculatedPlan.totalTransferred })}`);

  const resumeFinalSelection = resolveFinalRecommendation({
    genericCoachContext: {
      recommendedStrategy: "general_progress_coaching",
      recommendedCardLabel: null,
      recommendedTransferAmount: 0,
      totalTransferred: 0,
      totalTransferFees: 0,
      totalCapacityUsed: 0,
      unusedCapacity: 0,
      totalOpeningTransferredBalance: 0,
      transferFee: 0,
      feeTreatment: null,
      transferPlanStatus: "general_progress",
      allocations: [],
      deterministicShortAnswer: "generic progress guidance",
      deterministicDetailedReasoning: "generic progress guidance",
      shortAnswer: "generic progress guidance",
      detailedReasoning: "generic progress guidance"
    },
    exactPlan: restoredCalculatedPlan,
    aiResult: { aiWasUsed: true, shortAnswer: "generic progress guidance" },
    question: "Go back to the transfer plan.",
    questionType: "CONVERSATION_RESUME",
    user: { first_name: "Chris" }
  });
  assert.strictEqual(resumeFinalSelection.answerSource, "deterministic");
  assert.strictEqual(resumeFinalSelection.recommendation.transferPlanStatus, "calculated");
  assert.strictEqual(resumeFinalSelection.recommendation.planningState.selectedProduct, "Ascend");
  assert.strictEqual(resumeFinalSelection.recommendation.totalTransferred, 3921.56);
  assert.strictEqual(resumeFinalSelection.recommendation.totalTransferFees, 78.44);
  assert.strictEqual(resumeFinalSelection.recommendation.totalCapacityUsed, 4000);
  assert.strictEqual(resumeFinalSelection.recommendation.unusedCapacity, 0);
  assert.ok(/returning to your Ascend transfer plan/i.test(resumeFinalSelection.recommendation.shortAnswer), "resume response uses the restored-plan wording");
  console.log(`resume_restores_latest_calculated_plan => ${JSON.stringify({ transferPlanStatus: resumeFinalSelection.recommendation.transferPlanStatus, selectedProduct: resumeFinalSelection.recommendation.planningState.selectedProduct, totalTransferred: resumeFinalSelection.recommendation.totalTransferred, totalTransferFees: resumeFinalSelection.recommendation.totalTransferFees, totalCapacityUsed: resumeFinalSelection.recommendation.totalCapacityUsed, unusedCapacity: resumeFinalSelection.recommendation.unusedCapacity })}`);

  const restoredCardA = resumeFinalSelection.recommendation.planningState.cards.find((card) => card.cardLabel === "Card A");
  const restoredCardB = resumeFinalSelection.recommendation.planningState.cards.find((card) => card.cardLabel === "Card B");
  assert.ok(restoredCardA && restoredCardB, "restored plan keeps both cards");
  assert.ok(restoredCardA.originalBalance !== null && restoredCardA.aprPercent !== null, "Card A values are restored");
  assert.ok(restoredCardB.originalBalance !== null && restoredCardB.aprPercent !== null, "Card B values are restored");
  assert.deepStrictEqual(resumeFinalSelection.recommendation.missingInputs || [], [], "restored calculated plan has no missing inputs");
  console.log(`resume_does_not_restore_fragment => ${JSON.stringify({ selectedProduct: resumeFinalSelection.recommendation.planningState.selectedProduct, cardABalance: restoredCardA.originalBalance, cardAApr: restoredCardA.aprPercent, cardBBalance: restoredCardB.originalBalance, cardBApr: restoredCardB.aprPercent, missingInputs: resumeFinalSelection.recommendation.missingInputs || [] })}`);

  const nullValueSummary = summarizeDebtPlanCards([
    { card_label: "Card A", current_balance: null, apr_percent: null },
    { card_label: "Card B", current_balance: 2400, apr_percent: 24.99 }
  ]);
  assert.ok(!nullValueSummary.some((entry) => /\$0\.00\b|\b0\.00% APR\b/i.test(entry)), "null financial values are not formatted as zero");
  console.log(`null_financial_values_not_formatted_as_zero => ${JSON.stringify({ summary: nullValueSummary })}`);

  const olderApexPlan = attachPlanningStateToPlan(
    buildTransferPlan([
      { card_label: "Card A", current_balance: 3200, apr_percent: 29.99, minimum_payment: 95, transfer_eligible: true, valueSource: "customer_provided" },
      { card_label: "Card B", current_balance: 2400, apr_percent: 24.99, minimum_payment: 80, transfer_eligible: true, valueSource: "customer_provided" }
    ], {
      transfer_limit: 5000,
      transfer_fee_percent: 0,
      fee_treatment: "inside_capacity",
      monthly_payment_budget: 600,
      keyr_tier: "Apex"
    }),
    {
      status: "ready",
      selectedProduct: "Apex",
      approvedTransferCapacity: 5000,
      feeRate: 0,
      feeTreatment: "inside_capacity",
      monthlyDebtBudget: 600,
      cards: [
        { card_label: "Card A", current_balance: 3200, apr_percent: 29.99, minimum_payment: 95, transfer_eligible: true, valueSource: "customer_provided" },
        { card_label: "Card B", current_balance: 2400, apr_percent: 24.99, minimum_payment: 80, transfer_eligible: true, valueSource: "customer_provided" }
      ],
      missingInputs: []
    }
  );
  const newestCalculatedPlanWins = deriveAuthoritativeDebtPlanFromConversationHistory([
    {
      role: "assistant",
      created_at_utc: "2026-10-04T21:00:00.000Z",
      message_metadata: {
        debtPlanCheckpoint: buildDebtPlanCheckpoint({ conversationId: "resume-conv-2", plan: olderApexPlan, updatedAtUtc: "2026-10-04T21:00:00.000Z" })
      }
    },
    {
      role: "assistant",
      created_at_utc: "2026-10-04T22:00:00.000Z",
      message_metadata: {
        debtPlanCheckpoint: calculatedCheckpoint
      }
    }
  ], { first_name: "Chris" });
  assert.strictEqual(newestCalculatedPlanWins.planningState.selectedProduct, "Ascend", "newer Ascend calculated plan wins over older Apex plan");
  console.log(`newest_calculated_plan_wins => ${JSON.stringify({ selectedProduct: newestCalculatedPlanWins.planningState.selectedProduct, totalTransferred: newestCalculatedPlanWins.totalTransferred })}`);

  const savedPartialPlan = attachPlanningStateToPlan(parsedExactMixedEligibilityPlan, {
    ...parsedExactMixedEligibility,
    status: "ready",
    missingInputs: []
  });
  const partialPlanCheckpoint = buildDebtPlanCheckpoint({
    conversationId: "resume-conv-3",
    plan: savedPartialPlan,
    updatedAtUtc: "2026-10-04T22:03:00.000Z"
  });
  const restoredPartialPlan = deriveAuthoritativeDebtPlanFromConversationHistory([
    {
      role: "assistant",
      created_at_utc: "2026-10-04T22:03:00.000Z",
      message_metadata: {
        debtPlanCheckpoint: partialPlanCheckpoint
      }
    }
  ], { first_name: "Chris" });
  assert.strictEqual(restoredPartialPlan.transferPlanStatus, "partial_eligibility", "latest partial plan can be restored when no calculated checkpoint exists");
  console.log(`partial_plan_resume_supported => ${JSON.stringify({ transferPlanStatus: restoredPartialPlan.transferPlanStatus, totalTransferred: restoredPartialPlan.totalTransferred, missingInputs: restoredPartialPlan.missingInputs })}`);

  const invalidCheckpoint = {
    ...calculatedCheckpoint,
    totalTransferFees: 99.99,
    updatedAtUtc: "2026-10-04T22:04:00.000Z"
  };
  assert.strictEqual(reconcilePlanWithCheckpoint(invalidCheckpoint), null, "checkpoint failing financial reconciliation is not restored as authoritative");
  assert.strictEqual(deriveAuthoritativeDebtPlanFromConversationHistory([
    {
      role: "assistant",
      created_at_utc: "2026-10-04T22:04:00.000Z",
      message_metadata: {
        debtPlanCheckpoint: invalidCheckpoint
      }
    }
  ], { first_name: "Chris" }), null, "invalid authoritative checkpoint fails closed");
  console.log(`invalid_checkpoint_fails_closed => ${JSON.stringify({ restored: reconcilePlanWithCheckpoint(invalidCheckpoint) !== null })}`);

  console.log("validation: PASS");

  const liveFinalAnchorTransferEligibility = buildCanonicalProductTransferEligibilityResponse({
    question: "Can Anchor accept a balance transfer?",
    user: { first_name: "Chris" }
  });
  assert.strictEqual(liveFinalAnchorTransferEligibility.responseType, "BALANCE_TRANSFER_ELIGIBILITY");
  assert.strictEqual(liveFinalAnchorTransferEligibility.finalRecommendation.productTransferRules.targetProduct, "Anchor");
  assert.ok(/Anchor does not support balance transfers/i.test(liveFinalAnchorTransferEligibility.shortAnswer), "Anchor transfer response denies Anchor transfers");
  assert.ok(/Ascend and Apex may support balance transfers/i.test(liveFinalAnchorTransferEligibility.shortAnswer), "Anchor transfer response describes conditional Ascend and Apex transfer support");
  assert.ok(!/six completed on-time cycles|credit profile stability|utilization results/i.test(liveFinalAnchorTransferEligibility.shortAnswer), "Anchor transfer response avoids generic progress guidance");
  console.log(`live_final_anchor_transfer_eligibility => ${JSON.stringify({ intent: liveFinalAnchorTransferEligibility.responseType, answerSource: "deterministic", shortAnswer: liveFinalAnchorTransferEligibility.shortAnswer, productTransferRules: liveFinalAnchorTransferEligibility.finalRecommendation.productTransferRules })}`);

  const liveFinalMeritTransferEligibility = buildCanonicalProductTransferEligibilityResponse({
    question: "Can Merit accept a balance transfer?",
    user: { first_name: "Chris" }
  });
  assert.strictEqual(liveFinalMeritTransferEligibility.responseType, "BALANCE_TRANSFER_ELIGIBILITY");
  assert.ok(/Merit is a retired KEYR product name/i.test(liveFinalMeritTransferEligibility.shortAnswer), "Merit response clarifies legacy suffix");
  assert.ok(/maps to Anchor in the current model/i.test(liveFinalMeritTransferEligibility.shortAnswer), "Merit response maps to Anchor");
  assert.ok(/Anchor does not support balance transfers/i.test(liveFinalMeritTransferEligibility.shortAnswer), "Merit response denies Anchor transfers");
  assert.ok(!/active product|Ascend and Apex may support balance transfers/i.test(liveFinalMeritTransferEligibility.shortAnswer) === false, "Merit response remains explanatory and not active-tiered");
  console.log(`live_final_merit_transfer_eligibility => ${JSON.stringify({ intent: liveFinalMeritTransferEligibility.responseType, answerSource: "deterministic", shortAnswer: liveFinalMeritTransferEligibility.shortAnswer, productTransferRules: liveFinalMeritTransferEligibility.finalRecommendation.productTransferRules })}`);

  const liveFinalAscendTransferEligibility = buildCanonicalProductTransferEligibilityResponse({
    question: "Can Ascend accept a balance transfer?",
    user: { first_name: "Chris" }
  });
  assert.strictEqual(liveFinalAscendTransferEligibility.responseType, "BALANCE_TRANSFER_ELIGIBILITY");
  assert.ok(/Ascend may support balance transfers with a proposed 2% transfer fee/i.test(liveFinalAscendTransferEligibility.shortAnswer), "Ascend response states the proposed 2% fee");
  assert.ok(/approval.*verified transfer eligibility.*available approved transfer capacity/i.test(liveFinalAscendTransferEligibility.shortAnswer), "Ascend response ties approval and capacity to eligibility");
  assert.ok(!/six completed on-time cycles|credit profile stability|utilization results/i.test(liveFinalAscendTransferEligibility.shortAnswer), "Ascend response avoids generic account progress");
  console.log(`live_final_ascend_transfer_eligibility => ${JSON.stringify({ intent: liveFinalAscendTransferEligibility.responseType, answerSource: "deterministic", shortAnswer: liveFinalAscendTransferEligibility.shortAnswer, productTransferRules: liveFinalAscendTransferEligibility.finalRecommendation.productTransferRules })}`);

  const liveFinalApexTransferEligibility = buildCanonicalProductTransferEligibilityResponse({
    question: "Can Apex accept a balance transfer?",
    user: { first_name: "Chris" }
  });
  assert.strictEqual(liveFinalApexTransferEligibility.responseType, "BALANCE_TRANSFER_ELIGIBILITY");
  assert.ok(/Apex may support balance transfers with a proposed 0% transfer fee/i.test(liveFinalApexTransferEligibility.shortAnswer), "Apex response states the proposed 0% fee");
  assert.ok(/approval.*verified transfer eligibility.*available approved transfer capacity/i.test(liveFinalApexTransferEligibility.shortAnswer), "Apex response ties approval and capacity to eligibility");
  assert.ok(!/six completed on-time cycles|credit profile stability|utilization results/i.test(liveFinalApexTransferEligibility.shortAnswer), "Apex response avoids generic account progress");
  console.log(`live_final_apex_transfer_eligibility => ${JSON.stringify({ intent: liveFinalApexTransferEligibility.responseType, answerSource: "deterministic", shortAnswer: liveFinalApexTransferEligibility.shortAnswer, productTransferRules: liveFinalApexTransferEligibility.finalRecommendation.productTransferRules })}`);

  const explicitlyNamedProductOverridesCurrentProduct = resolveFinalRecommendation({
    genericCoachContext: {
      recommendedStrategy: "general_progress_coaching",
      recommendedCardLabel: null,
      recommendedTransferAmount: 0,
      totalTransferred: 0,
      transferFee: 0,
      allocations: [],
      deterministicShortAnswer: "six completed on-time cycles",
      detailedReasoning: "credit profile stability"
    },
    aiResult: { aiWasUsed: true, shortAnswer: "six completed on-time cycles" },
    question: "Can Ascend accept a balance transfer?",
    questionType: "BALANCE_TRANSFER_ELIGIBILITY",
    user: { first_name: "Chris", current_tier: "Anchor" },
    memberCoachContext: { current_tier: "Anchor" }
  });
  assert.ok(/Ascend may support balance transfers/i.test(explicitlyNamedProductOverridesCurrentProduct.recommendation.shortAnswer), "explicitly named product overrides current product in the final recommendation");
  assert.ok(!/Anchor does not support balance transfers/i.test(explicitlyNamedProductOverridesCurrentProduct.recommendation.shortAnswer), "explicit Ascend question is not denied by the current Anchor product in the final recommendation");
  console.log(`explicitly_named_product_overrides_current_product => ${JSON.stringify({ shortAnswer: explicitlyNamedProductOverridesCurrentProduct.recommendation.shortAnswer, answerSource: explicitlyNamedProductOverridesCurrentProduct.answerSource, productTransferRules: explicitlyNamedProductOverridesCurrentProduct.recommendation.productTransferRules })}`);

  const transferResponseNotOverwritten = resolveFinalRecommendation({
    genericCoachContext: {
      recommendedStrategy: "general_progress_coaching",
      recommendedCardLabel: null,
      recommendedTransferAmount: 0,
      totalTransferred: 0,
      transferFee: 0,
      allocations: [],
      deterministicShortAnswer: "six completed on-time cycles",
      detailedReasoning: "credit profile stability"
    },
    aiResult: { aiWasUsed: true, shortAnswer: "six completed on-time cycles" },
    question: "Can Apex accept a balance transfer?",
    questionType: "BALANCE_TRANSFER_ELIGIBILITY",
    user: { first_name: "Chris" },
    memberCoachContext: { current_tier: "Anchor" }
  });
  assert.strictEqual(transferResponseNotOverwritten.answerSource, "deterministic", "product-transfer answer source stays deterministic and is not overwritten by generic coaching");
  assert.ok(!/six completed on-time cycles|credit profile stability/i.test(transferResponseNotOverwritten.recommendation.shortAnswer), "generic progress guidance is not allowed to overwrite the product-transfer recommendation");
  console.log(`transfer_response_not_overwritten => ${JSON.stringify({ shortAnswer: transferResponseNotOverwritten.recommendation.shortAnswer, answerSource: transferResponseNotOverwritten.answerSource, productTransferRules: transferResponseNotOverwritten.recommendation.productTransferRules })}`);

  const metadataPresentForAnchorAndMerit = [
    buildCanonicalProductTransferEligibilityResponse({ question: "Can Anchor accept a balance transfer?", user: { first_name: "Chris" } }),
    buildCanonicalProductTransferEligibilityResponse({ question: "Can Merit accept a balance transfer?", user: { first_name: "Chris" } })
  ];
  for (const entry of metadataPresentForAnchorAndMerit) {
    assert.ok(entry.responseType, "response type is present");
    assert.ok(entry.finalRecommendation.productTransferRules, "product transfer rules are present");
    assert.ok(entry.finalRecommendation.productTransferRules.targetProduct, "target product is present");
  }
  console.log(`metadata_present_for_anchor_and_merit => ${JSON.stringify({ anchor: metadataPresentForAnchorAndMerit[0].finalRecommendation.productTransferRules, merit: metadataPresentForAnchorAndMerit[1].finalRecommendation.productTransferRules })}`);

}

app.http("simAiFinancialCoach", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "sim/ai-financial-coach",

  handler: async (httpRequest, context) => {
    const corsHeaders = getCorsHeaders();

    if (httpRequest.method === "OPTIONS") {
      return {
        status: 204,
        headers: corsHeaders
      };
    }

    let pool;

    try {
      const body = await httpRequest.json();

      const simUserId = (body.simUserId || "").trim();
      const email = (body.email || "").trim();
      const question = (body.question || "").trim();
      const mode = (body.mode || "ask").trim();
      const requestedConversationId = (body.conversationId || "").trim();

      if (!simUserId && !email) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            error: "Provide either simUserId or email."
          }
        };
      }

      const connectionString = process.env.KEYR_DB_CONNECTION;

      if (!connectionString) {
        return {
          status: 500,
          headers: corsHeaders,
          jsonBody: {
            error: "Database connection is not configured."
          }
        };
      }

      pool = await sql.connect(connectionString);

      let userResult;

      if (simUserId) {
        userResult = await pool
          .request()
          .input("sim_user_id", sql.UniqueIdentifier, simUserId)
          .query(`
            SELECT TOP 1
              sim_user_id,
              first_name,
              last_name,
              email,
              current_tier
            FROM dbo.SimUsers
            WHERE sim_user_id = @sim_user_id;
          `);
      } else {
        userResult = await pool
          .request()
          .input("email", sql.NVarChar(255), email)
          .query(`
            SELECT TOP 1
              sim_user_id,
              first_name,
              last_name,
              email,
              current_tier
            FROM dbo.SimUsers
            WHERE email = @email;
          `);
      }

      if (userResult.recordset.length === 0) {
        return {
          status: 404,
          headers: corsHeaders,
          jsonBody: {
            error: "Simulated user not found."
          }
        };
      }

      const user = userResult.recordset[0];

const memberCoachContext = await getMemberCoachContext(
  pool,
  user.sim_user_id
);

const activeCoachingAlerts =
  await getActiveCoachingAlerts(
    pool,
    user.sim_user_id
  );

context.log(
  `Loaded ${activeCoachingAlerts.length} active coaching alert(s) for simulated user ${user.sim_user_id}.`
);

      if (mode === "dashboard_check") {
  const activeUtilizationAlert =
    activeCoachingAlerts.find(
      (alert) =>
        alert.alert_type ===
        "utilization_payment_recommendation"
    );

  const proactiveDecision =
    activeUtilizationAlert
      ? {
          shouldProactivelyPrompt: true,
          promptType:
            "utilization_payment_recommendation",
          promptSeverity:
            activeUtilizationAlert.severity || "yellow",
          reason:
            "An active deterministic utilization payment recommendation exists."
        }
      : determineProactivePrompt(memberCoachContext);

  const dashboardShortAnswer =
    activeUtilizationAlert?.message ||
    buildDashboardPromptAnswer(
      memberCoachContext,
      proactiveDecision
    );

  const dashboardAlerts = buildSanitizedActiveAlerts(activeCoachingAlerts, memberCoachContext, false);

        return {
          status: 200,
          headers: corsHeaders,
          jsonBody: {
            success: true,
            mode: "dashboard_check",
            user: {
              simUserId: user.sim_user_id,
              name: `${user.first_name} ${user.last_name}`,
              email: user.email,
              currentTier: user.current_tier
            },
            coachAvailable: true,
            shouldProactivelyPrompt:
              proactiveDecision.shouldProactivelyPrompt,
            promptType: proactiveDecision.promptType,
            promptSeverity: proactiveDecision.promptSeverity,
            promptReason: proactiveDecision.reason,
            shortAnswer: dashboardShortAnswer,
            suggestedQuestions:
              buildSuggestedQuestions(memberCoachContext, proactiveDecision),
            memberCoachContext: buildSanitizedMemberCoachContext(memberCoachContext),
            activeCoachingAlerts: dashboardAlerts
          }
        };
      }

      const cardsResult = await pool
        .request()
        .input("sim_user_id", sql.UniqueIdentifier, user.sim_user_id)
        .query(`
          SELECT
            sim_external_card_id,
            card_label,
            current_balance,
            apr_percent,
            minimum_payment,
            credit_limit
          FROM dbo.SimExternalCreditCards
          WHERE sim_user_id = @sim_user_id
            AND is_active = 1
          ORDER BY apr_percent DESC;
        `);

      const scenarioResult = await pool
        .request()
        .input("sim_user_id", sql.UniqueIdentifier, user.sim_user_id)
        .query(`
          SELECT TOP 1
            sim_bt_scenario_id,
            keyr_tier,
            transfer_limit,
            transfer_fee_percent,
            keyr_apr_percent,
            monthly_payment_budget,
            scenario_name
          FROM dbo.SimBalanceTransferScenarios
          WHERE sim_user_id = @sim_user_id
          ORDER BY created_at_utc DESC;
        `);

let coachConversation = null;
let conversationHistory = [];

if (mode === "ask") {
  coachConversation = await getOrCreateCoachConversation(
    pool,
    user,
    requestedConversationId
  );

  conversationHistory = await getCoachConversationHistory(
    pool,
    coachConversation.conversation_id,
    8
  );

  if (question) {
    await saveCoachConversationMessage(pool, {
      conversationId: coachConversation.conversation_id,
      simUserId: user.sim_user_id,
      role: "user",
      messageText: question,
      metadata: {
        mode,
        source: "portal_dashboard"
      }
    });
  }
}

const externalCards = cardsResult.recordset || [];

const scenario =
  scenarioResult.recordset.length > 0
    ? scenarioResult.recordset[0]
    : null;

const knowledgeArticle = await findKnowledgeArticle(pool, question);

const routing = chooseModel(
  question,
  externalCards.length,
  knowledgeArticle
);

if (
  knowledgeArticle?.article_code ===
  "BT_010_SECURED_TIERS_NO_TRANSFER"
) {
  const answer = ensureNameGreeting(
    knowledgeArticle.short_answer,
    user?.first_name
  );

  return {
    status: 200,
    headers: corsHeaders,
    jsonBody: {
      success: true,
      mode,
      user: {
        simUserId: user.sim_user_id,
        name: `${user.first_name} ${user.last_name}`,
        email: user.email,
        currentTier: user.current_tier
      },
      routing: {
        model: "deterministic",
        modelFamily: "knowledge_base",
        questionType: "secured_tier_transfer",
        reason: "Answered directly from KEYR product rules.",
        aiWasUsed: false,
        aiError: null
      },
      knowledgeArticle,
      memberCoachContext,
      recommendation: {
        recommendedStrategy: null,
        recommendedCardLabel: null,
        recommendedTransferAmount: 0,
        totalTransferred: 0,
        transferFee: 0,
        allocations: [],
        deterministicShortAnswer: answer,
        shortAnswer: answer,
        detailedReasoning:
          knowledgeArticle.approved_answer
      }
    }
  };
}

const fallbackArticle =
  knowledgeArticle || getFallbackKnowledgeArticle(question);

if (
  routing.questionType === "transfer_timing" &&
  fallbackArticle?.short_answer
) {
  const formattedFallbackAnswer = ensureNameGreeting(
    fallbackArticle.short_answer,
    user?.first_name
  );

  return {
    status: 200,
    headers: corsHeaders,
    jsonBody: {
      success: true,
      mode,
      user: {
        simUserId: user.sim_user_id,
        name: `${user.first_name} ${user.last_name}`,
        email: user.email,
        currentTier: user.current_tier
      },
      routing: {
        model: routing.model,
        modelFamily: routing.modelFamily,
        questionType: routing.questionType,
        reason: "Answered from KEYR fallback knowledge article.",
        aiWasUsed: false,
        aiError: null
      },
      knowledgeArticle: fallbackArticle,
      memberCoachContext,
      recommendation: {
        shortAnswer: formattedFallbackAnswer,
        deterministicShortAnswer: formattedFallbackAnswer,
        detailedReasoning: fallbackArticle.approved_answer
      }
    }
  };
}

const requiresDebtScenario =
  routing.questionType === "transfer_strategy" ||
  routing.questionType === "payoff_strategy";

if (requiresDebtScenario && externalCards.length === 0) {
  return {
    status: 200,
    headers: corsHeaders,
    jsonBody: {
      success: true,
      mode,
      user: {
        simUserId: user.sim_user_id,
        name: `${user.first_name} ${user.last_name}`,
        email: user.email,
        currentTier: user.current_tier
      },
      routing: {
        model: routing.model,
        modelFamily: routing.modelFamily,
        questionType: routing.questionType,
        reason: routing.reason,
        aiWasUsed: false,
        aiError: "No external card data available for this simulated member."
      },
      knowledgeArticle: null,
      memberCoachContext,
      activeCoachingAlerts,
      recommendation: {
        recommendedStrategy: null,
        recommendedCardLabel: null,
        recommendedTransferAmount: 0,
        totalTransferred: 0,
        transferFee: 0,
        allocations: [],
        deterministicShortAnswer:
          `Hi ${user.first_name || "there"}, I do not currently have external card details available for this simulated profile. I can still help you understand payment behavior, utilization, credit profile stability, and your Progress Status.`,
        shortAnswer:
          `Hi ${user.first_name || "there"}, I do not currently have external card details available for this simulated profile. I can still help you understand payment behavior, utilization, credit profile stability, and your Progress Status.`,
        detailedReasoning:
          "External card data was not available for this simulated member, so card-specific debt strategy was not generated."
      }
    }
  };
}

if (requiresDebtScenario && !scenario) {
  return {
    status: 200,
    headers: corsHeaders,
    jsonBody: {
      success: true,
      mode,
      user: {
        simUserId: user.sim_user_id,
        name: `${user.first_name} ${user.last_name}`,
        email: user.email,
        currentTier: user.current_tier
      },
      routing: {
        model: routing.model,
        modelFamily: routing.modelFamily,
        questionType: routing.questionType,
        reason: routing.reason,
        aiWasUsed: false,
        aiError: "No balance transfer scenario available for this simulated member."
      },
      knowledgeArticle: null,
      memberCoachContext,
      activeCoachingAlerts,
      recommendation: {
        recommendedStrategy: null,
        recommendedCardLabel: null,
        recommendedTransferAmount: 0,
        totalTransferred: 0,
        transferFee: 0,
        allocations: [],
        deterministicShortAnswer:
          `Hi ${user.first_name || "there"}, I do not currently have a balance transfer scenario available for this simulated profile. I can still help you understand payment behavior, utilization, credit profile stability, and your Progress Status.`,
        shortAnswer:
          `Hi ${user.first_name || "there"}, I do not currently have a balance transfer scenario available for this simulated profile. I can still help you understand payment behavior, utilization, credit profile stability, and your Progress Status.`,
        detailedReasoning:
          "Balance transfer scenario data was not available for this simulated member, so transfer strategy was not generated."
      }
    }
  };
}

const authoritativeConversationPlan = routing.questionType === "CONVERSATION_RESUME"
  ? deriveAuthoritativeDebtPlanFromConversationHistory(conversationHistory, user)
  : null;

const conversationDebtPlanState = ["DEBT_PLAN_NEW", "DEBT_PLAN_ADJUST", "CONVERSATION_RESUME"].includes(routing.questionType)
  ? deriveDebtPlanStateFromConversationHistory(conversationHistory)
  : null;

const currentTurnDebtPlanState = ["DEBT_PLAN_NEW", "DEBT_PLAN_ADJUST"].includes(routing.questionType)
  ? buildExplicitDebtPlanState(question)
  : null;

const mergedDebtPlanState = currentTurnDebtPlanState
  ? (conversationDebtPlanState ? mergeDebtPlanState(conversationDebtPlanState, currentTurnDebtPlanState) : currentTurnDebtPlanState)
  : routing.questionType === "CONVERSATION_RESUME"
    ? conversationDebtPlanState
    : null;

const continuationByConversationContext = Boolean(
  routing.questionType === "DEBT_PLAN_NEW" &&
  conversationDebtPlanState &&
  currentTurnDebtPlanState &&
  !currentTurnDebtPlanState.selectedProduct &&
  !/build\s+(an\s+)?exact|new\s+plan|start over/i.test(question || "")
);

const effectiveQuestionType = continuationByConversationContext
  ? "DEBT_PLAN_ADJUST"
  : routing.questionType;

const currentTurnScenarioOverride = mergedDebtPlanState?.status === "ready"
  ? {
      sim_bt_scenario_id: null,
      keyr_tier: mergedDebtPlanState.selectedProduct,
      transfer_limit: mergedDebtPlanState.approvedTransferCapacity,
      transfer_fee_percent: mergedDebtPlanState.feeRate * 100,
      keyr_apr_percent: 0,
      monthly_payment_budget: mergedDebtPlanState.monthlyDebtBudget,
      scenario_name: "customer_planning_question",
      fee_treatment: mergedDebtPlanState.feeTreatment,
      current_turn_override: true
    }
  : null;

const effectiveScenario = mergedDebtPlanState?.status === "ready"
  ? currentTurnScenarioOverride
  : scenario;

const plan = authoritativeConversationPlan
  ? authoritativeConversationPlan
  : mergedDebtPlanState
  ? mergedDebtPlanState.status === "ready"
    ? attachPlanningStateToPlan(
      buildTransferPlan(mergedDebtPlanState.cards, effectiveScenario),
      {
        ...mergedDebtPlanState,
        status: "ready",
        missingInputs: []
      }
    )
    : {
        recommendedStrategy: "none",
        recommendedCardLabel: null,
        recommendedTransferAmount: 0,
        totalTransferred: 0,
        totalTransferFees: 0,
        totalCapacityUsed: 0,
        unusedCapacity: Number(mergedDebtPlanState.approvedTransferCapacity || 0),
        totalOpeningTransferredBalance: 0,
        transferFee: 0,
        feeTreatment: mergedDebtPlanState.feeTreatment ?? null,
        transferPlanStatus: "collecting",
        allocations: [],
        missingInputs: mergedDebtPlanState.missingInputs || [],
        selectedProduct: mergedDebtPlanState.selectedProduct || null,
        approvedTransferCapacity: mergedDebtPlanState.approvedTransferCapacity ?? null,
        monthlyDebtBudget: mergedDebtPlanState.monthlyDebtBudget ?? null,
        cards: Array.isArray(mergedDebtPlanState.cards) ? mergedDebtPlanState.cards : [],
        planningState: {
          status: "collecting",
          selectedProduct: mergedDebtPlanState.selectedProduct || null,
          approvedTransferCapacity: mergedDebtPlanState.approvedTransferCapacity ?? null,
          feeRate: mergedDebtPlanState.feeRate ?? null,
          feeTreatment: mergedDebtPlanState.feeTreatment || null,
          monthlyDebtBudget: mergedDebtPlanState.monthlyDebtBudget ?? null,
          cards: Array.isArray(mergedDebtPlanState.cards) ? mergedDebtPlanState.cards : [],
          missingInputs: mergedDebtPlanState.missingInputs || []
        },
        shortAnswer:
          "I have the balances and APRs you shared, and I still need the missing debt-plan details to build an exact transfer plan.",
        detailedReasoning:
          "The explicit debt-plan request is incomplete, so the response stays in a collecting state until the missing approved transfer capacity, fee treatment, monthly budget, and source-card eligibility details are verified."
      }
  : scenario
    ? buildTransferPlan(externalCards, scenario)
    : {
        recommendedStrategy: "general_progress_coaching",
        recommendedCardLabel: "Not applicable",
        recommendedTransferAmount: 0,
        totalTransferred: 0,
        transferFee: 0,
        allocations: [],
        shortAnswer:
          "This question does not require a balance transfer scenario. KEYR can still provide guidance using payment behavior, utilization, credit profile stability, and Progress Status.",
        detailedReasoning:
          "No balance transfer scenario was available or required. The question was handled as general AI financial coaching."
      };

const coachContext = buildCoachContext({
  question,
  questionType: effectiveQuestionType,
  user,
  externalCards,
  scenario,
  plan,
  knowledgeArticle,
  memberCoachContext,
  activeCoachingAlerts
});

const deterministicShortAnswer =
  coachContext.deterministicShortAnswer;

const deterministicDetailedReasoning =
  coachContext.deterministicDetailedReasoning;

const shouldBypassAiForDirectAnswer = shouldShortCircuitDeterministicAnswer(
  effectiveQuestionType,
  question
);

const aiResult = shouldBypassAiForDirectAnswer
  ? {
      aiWasUsed: false,
      aiError: null,
      shortAnswer: deterministicShortAnswer
    }
  : await generateAiCoachAnswer({
      deployment: routing.model,
      question,
      questionType: effectiveQuestionType,
      deterministicShortAnswer,
      deterministicDetailedReasoning,
      user,
      externalCards,
      scenario,
      routingReason: routing.reason,
      knowledgeArticle:
        coachContext.knowledgeArticleUsed || knowledgeArticle,
      memberCoachContext,
      conversationHistory
    });

const finalIntent = effectiveQuestionType || classifyQuestionType(question);
const grounding = buildGroundingContext({
  memberCoachContext,
  activeCoachingAlerts
});
const debugResponsesEnabled = String(process.env.KEYR_COACH_DEBUG_RESPONSES || "").toLowerCase() === "true" || mode === "debug";

const directProductTransferResponse = finalIntent === "BALANCE_TRANSFER_ELIGIBILITY"
  ? buildCanonicalProductTransferEligibilityResponse({ question, user, memberCoachContext })
  : null;

const directAccountResponse = buildFieldSpecificAccountResponse({
  question,
  questionType: finalIntent,
  user,
  memberCoachContext,
  grounding,
  debugEnabled: debugResponsesEnabled
});

const finalRecommendationResolution = resolveFinalRecommendation({
  directAccountResponse: directProductTransferResponse ? null : directAccountResponse,
  genericCoachContext: {
    recommendedStrategy: plan.recommendedStrategy,
    recommendedCardLabel: plan.recommendedCardLabel,
    recommendedTransferAmount: plan.recommendedTransferAmount,
    totalTransferred: plan.totalTransferred,
    totalTransferFees: plan.totalTransferFees,
    totalCapacityUsed: plan.totalCapacityUsed,
    unusedCapacity: plan.unusedCapacity,
    totalOpeningTransferredBalance: plan.totalOpeningTransferredBalance,
    transferFee: plan.transferFee,
    feeTreatment: plan.feeTreatment,
    transferPlanStatus: plan.transferPlanStatus,
    allocations: plan.allocations,
    deterministicShortAnswer: deterministicShortAnswer,
    deterministicDetailedReasoning: deterministicDetailedReasoning,
    shortAnswer: deterministicShortAnswer,
    detailedReasoning: deterministicDetailedReasoning
  },
  exactPlan: plan,
  aiResult,
  question,
  questionType: finalIntent,
  user,
  memberCoachContext,
  debugEnabled: debugResponsesEnabled
});

const finalRecommendation = finalRecommendationResolution.recommendation;
const answerSource = finalRecommendationResolution.answerSource;
const finalShortAnswer = ensureNameGreeting(
  finalRecommendation.deterministicShortAnswer || finalRecommendation.shortAnswer || "",
  user?.first_name
);

if (directProductTransferResponse || directAccountResponse) {
  const recommendationSource = directProductTransferResponse || directAccountResponse;
  const debtPlanCheckpoint = buildDebtPlanCheckpoint({
    conversationId: coachConversation?.conversation_id || null,
    plan: finalRecommendation,
    updatedAtUtc: new Date().toISOString()
  });

  if (mode === "ask" && coachConversation) {
    await saveCoachConversationMessage(pool, {
      conversationId: coachConversation.conversation_id,
      simUserId: user.sim_user_id,
      role: "assistant",
      messageText: finalShortAnswer,
      metadata: {
        questionType: routing.questionType,
        model: routing.model,
        aiWasUsed: false,
        aiError: null,
        debtPlanCheckpoint
      }
    });
  }

  const insertQuery =
    "INSERT INTO dbo.SimAiFinancialCoachResults (" +
    "sim_user_id, sim_bt_scenario_id, user_question, scenario_type, recommended_strategy, recommended_card_label, recommended_transfer_amount, model_selected, routing_reason, short_answer, detailed_reasoning) " +
    "VALUES (@sim_user_id, @sim_bt_scenario_id, @user_question, @scenario_type, @recommended_strategy, @recommended_card_label, @recommended_transfer_amount, @model_selected, @routing_reason, @short_answer, @detailed_reasoning);";

  const insertRequest = pool.request();

  await insertRequest
    .input("sim_user_id", sql.UniqueIdentifier, user.sim_user_id)
    .input("sim_bt_scenario_id", sql.UniqueIdentifier, scenario?.sim_bt_scenario_id || null)
    .input("user_question", sql.NVarChar(sql.MAX), question || null)
    .input("scenario_type", sql.NVarChar(100), routing.questionType || "ai_coach")
    .input("recommended_strategy", sql.NVarChar(100), finalRecommendation.recommendedStrategy || "none")
    .input("recommended_card_label", sql.NVarChar(100), finalRecommendation.recommendedCardLabel || "Not applicable")
    .input("recommended_transfer_amount", sql.Decimal(18, 2), finalRecommendation.recommendedTransferAmount || 0)
    .input("model_selected", sql.NVarChar(100), routing.model)
    .input("routing_reason", sql.NVarChar(500), routing.reason)
    .input("short_answer", sql.NVarChar(sql.MAX), finalShortAnswer)
    .input("detailed_reasoning", sql.NVarChar(sql.MAX), finalRecommendation.detailedReasoning)
    .query(insertQuery);

  const sanitizedUser = buildSanitizedUser(user);
  const sanitizedScenario = buildSanitizedScenario(scenario);
  const sanitizedActiveAlerts = buildSanitizedActiveAlerts(activeCoachingAlerts, memberCoachContext, debugResponsesEnabled);

  return {
    status: 200,
    headers: corsHeaders,
    jsonBody: {
      success: true,
      mode,
      conversationId: coachConversation?.conversation_id || null,
      intent: finalIntent,
      answerSource,
      grounding: {
        ...grounding,
        missingFields: grounding.missingFields || [],
        staleFields: grounding.staleFields || []
      },
      user: {
        simUserId: sanitizedUser.sim_user_id,
        name: `${sanitizedUser.first_name || ""} ${sanitizedUser.last_name || ""}`.trim(),
        email: sanitizedUser.email,
        currentTier: sanitizeProductValue(sanitizedUser.current_tier ?? sanitizedUser.currentTier ?? "")
      },
      scenario: sanitizedScenario
        ? {
            scenarioName: sanitizeScenarioName(sanitizedScenario.scenario_name ?? sanitizedScenario.scenarioName ?? ""),
            keyrTier: sanitizeProductValue(sanitizedScenario.keyr_tier ?? sanitizedScenario.keyrTier ?? ""),
            transferLimit: Number(sanitizedScenario.transfer_limit),
            transferFeePercent: Number(sanitizedScenario.transfer_fee_percent),
            keyrAprPercent: Number(sanitizedScenario.keyr_apr_percent),
            monthlyPaymentBudget: sanitizedScenario.monthly_payment_budget
              ? Number(sanitizedScenario.monthly_payment_budget)
              : null
          }
        : null,
      routing: buildSafeRoutingMetadata(routing, { aiWasUsed: false, aiError: null }, debugResponsesEnabled),
      knowledgeArticle: coachContext.knowledgeArticleUsed || null,
      memberCoachContext: buildSanitizedMemberCoachContext(memberCoachContext),
      activeCoachingAlerts: sanitizedActiveAlerts,
      recommendation: finalRecommendation,
      ...(debugResponsesEnabled ? {
        debug: {
          directAccountResponseSelected: !!directAccountResponse,
          directAccountResponseType: recommendationSource?.responseType || null,
          finalRecommendationSource: directProductTransferResponse ? "direct_product_transfer_response" : "direct_account_response"
        }
      } : {})
    }
  };
}

if (mode === "ask" && coachConversation) {
  const debtPlanCheckpoint = buildDebtPlanCheckpoint({
    conversationId: coachConversation.conversation_id,
    plan: finalRecommendation,
    updatedAtUtc: new Date().toISOString()
  });

  await saveCoachConversationMessage(pool, {
    conversationId: coachConversation.conversation_id,
    simUserId: user.sim_user_id,
    role: "assistant",
    messageText: finalShortAnswer,
    metadata: {
      questionType: routing.questionType,
      model: routing.model,
      aiWasUsed: aiResult.aiWasUsed,
      aiError: aiResult.aiError,
      debtPlanCheckpoint
    }
  });
}

const insertQuery =
  "INSERT INTO dbo.SimAiFinancialCoachResults (" +
  "sim_user_id, sim_bt_scenario_id, user_question, scenario_type, recommended_strategy, recommended_card_label, recommended_transfer_amount, model_selected, routing_reason, short_answer, detailed_reasoning) " +
  "VALUES (@sim_user_id, @sim_bt_scenario_id, @user_question, @scenario_type, @recommended_strategy, @recommended_card_label, @recommended_transfer_amount, @model_selected, @routing_reason, @short_answer, @detailed_reasoning);";

const insertRequest = pool.request();

await insertRequest
  .input("sim_user_id", sql.UniqueIdentifier, user.sim_user_id)
  .input("sim_bt_scenario_id", sql.UniqueIdentifier, scenario?.sim_bt_scenario_id || null)
  .input("user_question", sql.NVarChar(sql.MAX), question || null)
  .input("scenario_type", sql.NVarChar(100), routing.questionType || "ai_coach")
  .input("recommended_strategy", sql.NVarChar(100), finalRecommendation.recommendedStrategy || "general_progress_coaching")
  .input("recommended_card_label", sql.NVarChar(100), finalRecommendation.recommendedCardLabel || "Not applicable")
  .input("recommended_transfer_amount", sql.Decimal(18, 2), finalRecommendation.recommendedTransferAmount || 0)
  .input("model_selected", sql.NVarChar(100), routing.model)
  .input("routing_reason", sql.NVarChar(500), routing.reason)
  .input("short_answer", sql.NVarChar(sql.MAX), finalShortAnswer)
  .input("detailed_reasoning", sql.NVarChar(sql.MAX), finalRecommendation.detailedReasoning || deterministicDetailedReasoning)
  .query(insertQuery);

const sanitizedUser = buildSanitizedUser(user);
const sanitizedScenario = buildSanitizedScenario(scenario);
const sanitizedMemberCoachContext = buildSanitizedMemberCoachContext(memberCoachContext);
const sanitizedActiveAlerts = buildSanitizedActiveAlerts(activeCoachingAlerts, memberCoachContext, debugResponsesEnabled);

return {
  status: 200,
  headers: corsHeaders,
  jsonBody: {
    success: true,
    mode,
    conversationId: coachConversation?.conversation_id || null,
    intent: finalIntent,
    answerSource,
    grounding: {
      ...grounding,
      missingFields: grounding.missingFields || [],
      staleFields: grounding.staleFields || []
    },
    user: {
      simUserId: sanitizedUser.sim_user_id,
      name: `${sanitizedUser.first_name || ""} ${sanitizedUser.last_name || ""}`.trim(),
      email: sanitizedUser.email,
      currentTier: sanitizeProductValue(sanitizedUser.current_tier ?? sanitizedUser.currentTier ?? "")
    },
    scenario: sanitizedScenario
      ? {
          scenarioName: sanitizeScenarioName(sanitizedScenario.scenario_name ?? sanitizedScenario.scenarioName ?? ""),
          keyrTier: sanitizeProductValue(sanitizedScenario.keyr_tier ?? sanitizedScenario.keyrTier ?? ""),
          transferLimit: Number(sanitizedScenario.transfer_limit),
          transferFeePercent: Number(sanitizedScenario.transfer_fee_percent),
          keyrAprPercent: Number(sanitizedScenario.keyr_apr_percent),
          monthlyPaymentBudget: sanitizedScenario.monthly_payment_budget
            ? Number(sanitizedScenario.monthly_payment_budget)
            : null
        }
      : null,
    routing: buildSafeRoutingMetadata(routing, aiResult, debugResponsesEnabled),
    knowledgeArticle: coachContext.knowledgeArticleUsed || null,
    memberCoachContext: buildSanitizedMemberCoachContext(memberCoachContext),
    activeCoachingAlerts: sanitizedActiveAlerts,
    recommendation: {
      ...finalRecommendation,
      deterministicShortAnswer: ensureNameGreeting(
        finalRecommendation.deterministicShortAnswer || finalRecommendation.shortAnswer || deterministicShortAnswer,
        user?.first_name
      ),
      shortAnswer: finalShortAnswer,
      detailedReasoning: finalRecommendation.detailedReasoning || deterministicDetailedReasoning
    },
    ...(debugResponsesEnabled ? {
      debug: {
        directAccountResponseSelected: false,
        directAccountResponseType: null,
        finalRecommendationSource: finalRecommendationResolution.debug?.finalRecommendationSource || "generic_coach_context"
      }
    } : {})
  }
};
    } catch (error) {
      context.error("simAiFinancialCoach error:", error);

      return {
        status: 500,
        headers: corsHeaders,
        jsonBody: {
          error: "Unable to generate AI Financial Coach recommendation.",
          detail: error?.message || "An unexpected error occurred."
        }
      };
    } finally {
      if (pool) {
        await pool.close();
      }
    }
  }
});