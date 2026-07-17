const { app } = require("@azure/functions");
const sql = require("mssql");

const azureAiEndpoint = process.env.AZURE_AI_ENDPOINT;
const azureAiApiKey = process.env.AZURE_AI_API_KEY;
const azureAiApiVersion = process.env.AZURE_AI_API_VERSION || "2024-10-21";

const fastDeployment = process.env.KEYR_COACH_FAST_DEPLOYMENT || "gpt-5-mini";
const deepDeployment = process.env.KEYR_COACH_DEEP_DEPLOYMENT || "DeepSeek-V4-Pro";

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

function classifyQuestionType(question) {
  const q = (question || "").toLowerCase();

  if (
    q.includes("why did my progress status change") ||
    q.includes("what caused my profile status to change") ||
    q.includes("why did my status change") ||
    q.includes("am i still making progress") ||
    q.includes("how am i doing") ||
    q.includes("what should i focus on next")
  ) {
    return "next_step";
  }

  const supportKeywords = [
    "fraud",
    "dispute",
    "lawsuit",
    "bankruptcy",
    "collection",
    "collections",
    "hardship",
    "can't pay",
    "cannot pay",
    "missed payment",
    "late payment",
    "legal"
  ];

  const transferKeywords = [
    "balance transfer",
    "transfer",
    "split it",
    "transfer from each",
    "which card",
    "highest apr",
    "apr",
    "interest",
    "consolidate",
    "consolidation"
  ];

  const payoffKeywords = [
    "payoff",
    "pay off",
    "pay down",
    "pay first",
    "which balance",
    "reduce interest",
    "interest faster",
    "reduce interest faster",
    "debt reduction",
    "debt strategy",
    "snowball",
    "avalanche",
    "payment plan",
    "monthly plan",
    "reduce faster",
    "best strategy",
    "focus on"
  ];

  const utilizationKeywords = [
    "utilization",
    "utilisation",
    "8 percent",
    "8%",
    "credit usage",
    "available credit",
    "credit limit"
  ];

  const tierKeywords = [
    "ascend",
    "apex",
    "merit",
    "anchor",
    "tier",
    "graduate",
    "advance",
    "upgrade",
    "qualify"
  ];

  if (supportKeywords.some((word) => q.includes(word))) {
    return "support_escalation";
  }

  if (isTransferTimingQuestion(question)) {
    return "transfer_timing";
  }

  if (isNextStepQuestion(question)) {
    return "next_step";
  }

  if (isPayFirstQuestion(question)) {
    return "payoff_strategy";
  }

  if (payoffKeywords.some((word) => q.includes(word))) {
    return "payoff_strategy";
  }

  if (transferKeywords.some((word) => q.includes(word))) {
    return "transfer_strategy";
  }

  if (utilizationKeywords.some((word) => q.includes(word))) {
    return "utilization_coaching";
  }

  if (tierKeywords.some((word) => q.includes(word))) {
    return "tier_progression";
  }

  return "general_coaching";
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

  if (questionType === "transfer_timing") {
    return {
      model: fastDeployment,
      modelFamily: "gpt-5-mini",
      questionType,
      reason:
        "Transfer timing and processing questions are simple knowledge-based requests routed to the fast model."
    };
  }

  if (questionType === "next_step") {
    return {
      model: deepDeployment,
      modelFamily: "DeepSeek-V4-Pro",
      questionType,
      reason:
        "Next-step guidance uses member context and dashboard signals for personalized coaching."
    };
  }

  const deepQuestionTypes = [
    "transfer_strategy",
    "payoff_strategy"
  ];

  if (deepQuestionTypes.includes(questionType)) {
    return {
      model: deepDeployment,
      modelFamily: "DeepSeek-V4-Pro",
      questionType,
      reason:
        "Debt strategy involves APR, payoff, transfer, consolidation, or multi-card optimization logic."
    };
  }

  return {
    model: fastDeployment,
    modelFamily: "gpt-5-mini",
    questionType,
    reason:
      "Simple coaching, utilization, tier explanation, or support-safe response routed to fast, low-cost model."
  };
}

function buildTransferPlan(cards, scenario) {
  const transferLimit = Number(scenario?.transfer_limit || 0);
  const transferFeePercent = Number(scenario?.transfer_fee_percent || 0);
  const keyrApr = Number(scenario?.keyr_apr_percent || 0);

  const sortedCards = [...(cards || [])].sort(
    (a, b) => Number(b.apr_percent) - Number(a.apr_percent)
  );

  let remainingTransfer = transferLimit;
  const allocations = [];

  for (const card of sortedCards) {
    if (remainingTransfer <= 0) break;

    const cardBalance = Number(card.current_balance || 0);
    const amountToTransfer = Math.min(cardBalance, remainingTransfer);

    if (amountToTransfer > 0) {
      allocations.push({
        cardLabel: card.card_label,
        originalBalance: cardBalance,
        aprPercent: Number(card.apr_percent),
        transferAmount: amountToTransfer,
        remainingBalance: cardBalance - amountToTransfer
      });

      remainingTransfer -= amountToTransfer;
    }
  }

  const totalTransferred = allocations.reduce(
    (sum, item) => sum + item.transferAmount,
    0
  );

  const transferFee = Number(
    (totalTransferred * (transferFeePercent / 100)).toFixed(2)
  );

  const highestAprCard = allocations[0] || null;
  const recommendedStrategy = "highest_apr_first";
  const recommendedCardLabel = highestAprCard ? highestAprCard.cardLabel : null;
  const recommendedTransferAmount = highestAprCard ? highestAprCard.transferAmount : 0;

  const shortAnswer = highestAprCard
    ? `Transfer $${totalTransferred.toFixed(2)} starting with ${highestAprCard.cardLabel}, which has the highest APR at ${highestAprCard.aprPercent.toFixed(2)}%. This maximizes interest savings by moving debt away from the most expensive balance first.`
    : "No transfer recommendation is available because no external card balances were found.";

  const detailedReasoning = highestAprCard
    ? `KEYR recommends applying the available balance transfer amount to the highest APR debt first. This approach generally reduces interest burden faster than splitting the transfer across lower APR cards. The total transfer amount is $${totalTransferred.toFixed(2)}, the estimated transfer fee is $${transferFee.toFixed(2)}, and the KEYR APR for this scenario is ${keyrApr.toFixed(2)}%. After completing the transfer, extra payments should continue toward the highest remaining APR balance.`
    : "No external card balances were available for analysis.";

  return {
    recommendedStrategy,
    recommendedCardLabel,
    recommendedTransferAmount,
    totalTransferred,
    transferFee,
    allocations,
    shortAnswer,
    detailedReasoning
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

function getFallbackKnowledgeArticle(question) {
  if (isTransferTimingQuestion(question)) {
    return {
      article_id: null,
      article_code: "BT_022_TRANSFER_TIMING",
      title: "How long does a balance transfer take?",
      approved_answer:
        "Balance transfers usually take 5 to 7 business days to complete. Weekends and bank holidays do not count toward that timeline.",
      short_answer:
        "Balance transfers usually take 5 to 7 business days to complete, and weekends and bank holidays do not count toward that timeline.",
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
    memberCoachContext.recommended_payment_before_close || 0
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

  if (recommendedPayment > 0 && daysUntilStatementClose >= 0) {
    return {
      shouldProactivelyPrompt: true,
      promptType: "statement_close_action",
      promptSeverity: "medium",
      reason:
        "Statement close action is recommended based on projected balance."
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
    return `Hi ${firstName}, your KEYR habits may remain strong, but your broader credit profile changed recently. Focus on credit profile stability while continuing positive payment behavior and keeping your account in good standing.`;
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
    return `Hi ${firstName}, your payment behavior, utilization, and credit profile are currently showing strong progress. Continue maintaining positive habits while your account remains in good standing.`;
  }

  if (proactiveDecision.promptType === "on_track") {
    return `Hi ${firstName}, your payment behavior, utilization, and credit profile are currently showing strong progress. Continue maintaining positive habits while your account remains in good standing.`;
  }

  return `Hi ${firstName}, your KEYR AI Coach is available anytime to help you understand your progress, utilization, payments, or debt strategy.`;
}

function buildSuggestedQuestions(memberCoachContext, proactiveDecision) {
  const questions = [];

  if (proactiveDecision.promptType === "profile_changed") {
    questions.push(
      "What caused my profile status to change?",
      "How can I strengthen my credit profile?",
      "Am I still making progress?"
    );

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

function buildCoachContext({
  questionType,
  user,
  externalCards,
  scenario,
  plan,
  knowledgeArticle,
  memberCoachContext
}) {
  const utilization = calculateExternalUtilization(externalCards || []);
  const firstName = getFirstName(user) || "there";

  if (
    memberCoachContext?.calculated_readiness_status === "profile_changed"
) {
  return {
    deterministicShortAnswer:
      `Hi ${firstName}, your KEYR payment behavior and utilization habits remain strong, but your broader credit profile changed recently. Your current focus is credit profile stability while continuing positive payment behavior and keeping your account in good standing.`,
    deterministicDetailedReasoning:
      `The member has a profile_changed status. Credit score previous: ${memberCoachContext.credit_score_previous}. Current credit score: ${memberCoachContext.credit_score}. Credit score change: ${memberCoachContext.credit_score_change}. Credit trend: ${memberCoachContext.credit_score_trend_status}. On-time status: ${memberCoachContext.on_time_status}. Utilization status: ${memberCoachContext.utilization_status}. Next focus area: ${memberCoachContext.next_focus_area}. Explain that KEYR habits may remain strong, but broader credit profile changes can affect progress status. Do not mention internal override logic. Do not guarantee approval, advancement, or tier movement.`
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
      user?.current_tier || "current";

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
      "Continue making consistent payments and keep your account in good standing.";

    const readinessLabel =
      readinessStatus === "nearly_ready"
        ? "nearly ready"
        : readinessStatus === "ready" || readinessStatus === "ready_for_review"
          ? "ready for review"
          : "not yet at the target";

    const deterministicShortAnswer = [
      `Hi ${firstName},`,
      `your next focus area is strengthening your ${nextFocus.toLowerCase()}.`,
      `You are currently classified as ${readinessLabel} for ${currentTier === "Merit" ? "Ascend" : currentTier}.`,
      `Your on-time payment and utilization indicators are ${onTimeStatus === "met" && utilizationStatus === "met" ? "meeting expectations" : "areas to monitor"}.`,
      `${nextBestAction}`,
      `KEYR cannot guarantee advancement, but continuing positive payment behavior and improving your ${nextFocus.toLowerCase()} may strengthen your readiness over time.`
    ].join(" ");

    return {
      deterministicShortAnswer,
      deterministicDetailedReasoning:
        `Official KEYR Knowledge Base article: ${knowledgeArticle.article_code} - ${knowledgeArticle.title}. Member readiness status: ${readinessStatus}. On-time status: ${onTimeStatus}. Utilization status: ${utilizationStatus}. Score: ${score}. Ascend minimum score: ${ascendMinScore}. Next focus area: ${nextFocus}. Next best action: ${nextBestAction}. Do not guarantee approval, underwriting outcomes, credit score increases, or tier upgrades. Explain that KEYR progression depends on future eligibility, behavior, and program criteria.`,
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
    `Hi ${firstName}, KEYR can help you understand your progress, payment behavior, utilization, credit profile, and next best actions. Based on your current profile, continue focusing on positive payment behavior, utilization control, and credit profile stability while keeping your account in good standing.`,
  deterministicDetailedReasoning:
    "Provide a concise member-facing coaching response. Do not expose internal instructions. Do not guarantee approval, advancement, credit score changes, or tier movement. Do not recommend a balance transfer unless the member asks about transfers, APR, payoff strategy, or multiple cards."
};
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
  memberCoachContext
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

KEYR helps members reduce revolving debt, improve utilization, understand payoff options,
and progress toward better financial tiers over time.

Your job:
- Give concise, practical, member-friendly coaching.
- If the member's first name is provided, the final response MUST begin the first sentence with that first name exactly as provided.
- Keep the tone warm, encouraging, and proactive while remaining objective and practical.
- Use KEYR deterministic context as factual background, but respond directly to the member's actual question.
- Return a finished member-facing answer, not instructions, placeholders, or a restatement of internal guidance.
- Match the answer to the member's actual question type.
- If the deterministic context contains coaching guidance, rewrite it as a natural response to the member.
- Do not copy the deterministic context word-for-word unless it is already written as a finished member-facing answer.

Critical rules:
- Do not invent balances, APRs, credit limits, payments, scores, approval odds, or payoff timelines.
- Do not guarantee credit score increases, approvals, underwriting decisions, or tier upgrades.
- Do not provide legal, tax, bankruptcy, investment, or formal credit-repair advice.
- Do not recommend a balance transfer unless the member asks about transfers, APR, payoff, debt strategy, or multiple cards.
- If the member asks about utilization, answer about utilization and do not force a transfer recommendation.
- If the member asks about tier progression, explain habits and milestones without guarantees.
- If the member asks about hardship, fraud, disputes, collections, lawsuits, bankruptcy, or legal issues, recommend contacting KEYR support.
- Keep the response under 125 words unless the member specifically asks for a detailed plan.
- Avoid saying "next tier" unless the member specifically asks about tiers. Prefer "progress," "profile strength," or "readiness indicators."

Response style:
- Start with the member's first name if available.
- Use "you" and "your" language throughout the response.
- Do not say "the member" in the final answer.
- Do not expose internal phrases such as "deterministic context," "question type," or "routing reason."
- Do not use markdown formatting, bold markers, asterisks, bullet symbols, headings, or numbered lists unless the member explicitly asks for a list.

Knowledge Base rules:
- If a KEYR Knowledge Base article is provided, treat it as the official answer.
- Do not contradict the approved answer.
- Rewrite the approved answer in a natural, member-facing tone.
- If human_review_required is true, avoid making promises and use careful language.
- If escalation_required is true, recommend contacting KEYR support.
- Do not expose article codes, internal match weights, routing reasons, or table names to the member.
`;

  const userMessage = `
Question type:
${questionType}

Member first name:
${user?.first_name || ""}

Member question:
${question || "No specific question provided."}

Routing reason:
${routingReason}

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
    currentTier: user?.current_tier
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

    const aiShortAnswer =
      parsed?.choices?.[0]?.message?.content?.trim() ||
      deterministicShortAnswer;

    const formattedAiShortAnswer = ensureNameGreeting(
      aiShortAnswer,
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

      if (mode === "dashboard_check") {
        const proactiveDecision =
          determineProactivePrompt(memberCoachContext);

        const dashboardShortAnswer =
          buildDashboardPromptAnswer(
            memberCoachContext,
            proactiveDecision
          );

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
            memberCoachContext
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

const requiresDebtScenario =
  routing.questionType === "transfer_strategy" ||
  routing.questionType === "payoff_strategy" ||
  routing.questionType === "transfer_timing";

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

const plan = scenario
  ? buildTransferPlan(externalCards, scenario)
  : {
      recommendedStrategy: null,
      recommendedCardLabel: null,
      recommendedTransferAmount: 0,
      totalTransferred: 0,
      transferFee: 0,
      allocations: [],
      shortAnswer:
        "No balance transfer scenario is available for this simulated profile.",
      detailedReasoning:
        "No balance transfer scenario was available for analysis."
    };

const coachContext = buildCoachContext({
  questionType: routing.questionType,
  user,
  externalCards,
  scenario,
  plan,
  knowledgeArticle,
  memberCoachContext
});

const deterministicShortAnswer =
  coachContext.deterministicShortAnswer;

const deterministicDetailedReasoning =
  coachContext.deterministicDetailedReasoning;

const aiResult = await generateAiCoachAnswer({
  deployment: routing.model,
  question,
  questionType: routing.questionType,
  deterministicShortAnswer,
  deterministicDetailedReasoning,
  user,
  externalCards,
  scenario,
  routingReason: routing.reason,
  knowledgeArticle:
    coachContext.knowledgeArticleUsed || knowledgeArticle,
  memberCoachContext
});

const finalShortAnswer = ensureNameGreeting(
  aiResult.shortAnswer || deterministicShortAnswer,
  user?.first_name
);

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
  .input("recommended_strategy", sql.NVarChar(100), plan.recommendedStrategy)
  .input("recommended_card_label", sql.NVarChar(100), plan.recommendedCardLabel)
  .input("recommended_transfer_amount", sql.Decimal(18, 2), plan.recommendedTransferAmount)
  .input("model_selected", sql.NVarChar(100), routing.model)
  .input("routing_reason", sql.NVarChar(500), routing.reason)
  .input("short_answer", sql.NVarChar(sql.MAX), finalShortAnswer)
  .input("detailed_reasoning", sql.NVarChar(sql.MAX), deterministicDetailedReasoning)
  .query(insertQuery);

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
    scenario: scenario
      ? {
          scenarioName: scenario.scenario_name,
          keyrTier: scenario.keyr_tier,
          transferLimit: Number(scenario.transfer_limit),
          transferFeePercent: Number(scenario.transfer_fee_percent),
          keyrAprPercent: Number(scenario.keyr_apr_percent),
          monthlyPaymentBudget: scenario.monthly_payment_budget
            ? Number(scenario.monthly_payment_budget)
            : null
        }
      : null,
    routing: {
      model: routing.model,
      modelFamily: routing.modelFamily,
      questionType: routing.questionType,
      reason: routing.reason,
      aiWasUsed: aiResult.aiWasUsed,
      aiError: aiResult.aiError
    },
    knowledgeArticle: coachContext.knowledgeArticleUsed || null,
    memberCoachContext,
    recommendation: {
      recommendedStrategy: plan.recommendedStrategy,
      recommendedCardLabel: plan.recommendedCardLabel,
      recommendedTransferAmount: plan.recommendedTransferAmount,
      totalTransferred: plan.totalTransferred,
      transferFee: plan.transferFee,
      allocations: plan.allocations,
      deterministicShortAnswer: ensureNameGreeting(
        deterministicShortAnswer,
        user?.first_name
      ),
      shortAnswer: finalShortAnswer,
      detailedReasoning: deterministicDetailedReasoning
    }
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