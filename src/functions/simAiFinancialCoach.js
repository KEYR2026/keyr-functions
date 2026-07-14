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

function ensureNameGreeting(text, firstName) {
  const name = (firstName || "").trim();
  const cleanText = (text || "").trim();

  if (!name || !cleanText) {
    return cleanText;
  }

  const normalizedText = cleanText.replace(/^\s+/, "");
  const namePattern = new RegExp(`^(hi|hello)\\s+${escapeRegExp(name)}\\b|^${escapeRegExp(name)}\\b`, "i");

  if (namePattern.test(normalizedText)) {
    return normalizedText;
  }

  const rewrittenText = normalizedText
    .replace(/\bkeeping utilization lower\b/gi, "keeping your utilization lower")
    .replace(/\bthe member\b/gi, "you")
    .replace(/\bthis member\b/gi, "you")
    .replace(/\bmember's\b/gi, "your")
    .replace(/\bmember is\b/gi, "you are")
    .replace(/\bmember are\b/gi, "you are")
    .replace(/\btheir\b/gi, "your")
    .replace(/\bthey\b/gi, "you")
    .replace(/\bthem\b/gi, "you")
    .replace(/\btheir available credit\b/gi, "your available credit")
    .replace(/\bthis member's\b/gi, "your")
    .replace(/\bmember's simulated outside-card utilization\b/gi, "your simulated outside-card utilization")
    .replace(/\bmember's simulated outside card utilization\b/gi, "your simulated outside-card utilization")
    .replace(/\byou's\b/gi, "your")
    .replace(/\byou is\b/gi, "you are")
    .replace(/\byou are using\b/gi, "you are using")
    .replace(/\bmember's\s+/gi, "your ");

  const trimmedText = rewrittenText.replace(/^[\s,.;:]+/, "");
  const firstChar = trimmedText.charAt(0);
  const lowerCasedText = firstChar ? `${firstChar.toLowerCase()}${trimmedText.slice(1)}` : trimmedText;
  const sentenceFixedText = lowerCasedText
    .replace(/\bkeyr\b/gi, "KEYR")
    .replace(/\b(your|you)\b/gi, (match) => match.charAt(0).toUpperCase() + match.slice(1).toLowerCase())
    .replace(/\b(?:i|a|an|and|or|but|for|nor|so|yet|the|to|of|in|on|at|by|from|with|as|is|are|was|were|be|been|being|this|that|these|those|your|you)\b/gi, (match) => match.toLowerCase())
    .replace(/([.!?]\s+)([a-z])/g, (match, p1, p2) => `${p1}${p2.toUpperCase()}`);

  return `Hi ${name}, ${sentenceFixedText}`.replace(/,\s+/g, ", ");
}

function isTransferTimingQuestion(question) {
  const q = (question || "").toLowerCase();
  const hasTransferContext = q.includes("balance transfer") || q.includes("transfer");
  const hasTimingContext =
    q.includes("how long") ||
    q.includes("business day") ||
    q.includes("business days") ||
    q.includes("weekend") ||
    q.includes("weekends") ||
    q.includes("timing") ||
    q.includes("processing time");

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
    q.includes("reduce interest faster") ||
    q.includes("pay down") ||
    q.includes("highest apr")
  );
}

function getFallbackKnowledgeArticle(question) {
  const q = (question || "").toLowerCase();

  if (isTransferTimingQuestion(question)) {
    return {
      article_id: 999999,
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

  if (isPayFirstQuestion(question)) {
    return {
      article_id: 999998,
      article_code: "COACH_048_PAY_FIRST",
      title: "Which balance should I pay first to reduce interest faster?",
      approved_answer:
        "Pay the balance with the highest APR first if you want to reduce interest faster. This usually saves the most interest over time.",
      short_answer:
        "Pay the balance with the highest APR first to reduce interest faster.",
      recommended_model: "DeepSeek-V4-Pro",
      escalation_required: false,
      human_review_required: false,
      best_match_weight: 100
    };
  }

  return null;
}

function classifyQuestionType(question) {
  const q = (question || "").toLowerCase();

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
    "what should i do",
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
      reason: "Transfer timing and processing questions are simple knowledge-based requests routed to the fast model."
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
  const transferLimit = Number(scenario.transfer_limit || 0);
  const transferFeePercent = Number(scenario.transfer_fee_percent || 0);
  const keyrApr = Number(scenario.keyr_apr_percent || 0);

  const sortedCards = [...cards].sort(
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

  const transferFee = Number((totalTransferred * (transferFeePercent / 100)).toFixed(2));
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
  const totalBalance = cards.reduce(
    (sum, card) => sum + Number(card.current_balance || 0),
    0
  );

  const totalLimit = cards.reduce(
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

function getFirstName(user) {
  const rawName = user?.first_name || user?.firstName || user?.name || "";
  if (typeof rawName !== "string") {
    return "";
  }

  return rawName.trim().split(/\s+/)[0] || "";
}

function buildCoachContext({ questionType, user, externalCards, scenario, plan, knowledgeArticle, memberCoachContext }) {
  const utilization = calculateExternalUtilization(externalCards || []);

  if (questionType === "tier_progression" && knowledgeArticle) {
    const firstName = getFirstName(user);
    const readinessStatus = memberCoachContext?.calculated_readiness_status || "unknown";
    const currentTier = user?.current_tier || "current";
    const score = memberCoachContext?.credit_score;
    const ascendMinScore = memberCoachContext?.ascend_min_score;
    const nextFocus = memberCoachContext?.next_focus_area || "credit profile";
    const onTimeStatus = memberCoachContext?.on_time_status || "unknown";
    const utilizationStatus = memberCoachContext?.utilization_status || "unknown";

    const readinessLabel = readinessStatus === "nearly_ready"
      ? "nearly ready"
      : readinessStatus === "ready"
        ? "ready"
        : "not yet at the target";

    const deterministicShortAnswer = [
      `Hi ${firstName || "there"},`,
      `Based on your simulated profile, you are currently classified as ${readinessLabel} for ${currentTier === "Merit" ? "Ascend" : currentTier}.`,
      `Your on-time payment behavior and utilization indicators are meeting expectations, which are positive advancement signals.`,
      `Your next focus area is your ${nextFocus}. Your simulated score is currently ${score || "unknown"}, while ${currentTier === "Merit" ? "Ascend" : currentTier} readiness begins at ${ascendMinScore || "the target score"}.`,
      `KEYR cannot guarantee advancement or approval decisions, but you appear to be making strong progress toward ${currentTier === "Merit" ? "Ascend" : currentTier} readiness.`
    ].join(" ");

    return {
      deterministicShortAnswer,
      deterministicDetailedReasoning:
        `Official KEYR Knowledge Base article: ${knowledgeArticle.article_code} - ${knowledgeArticle.title}. Member readiness status: ${readinessStatus}. On-time status: ${onTimeStatus}. Utilization status: ${utilizationStatus}. Score: ${score}. Ascend minimum score: ${ascendMinScore}. Next focus area: ${nextFocus}. Do not guarantee approval, underwriting outcomes, credit score increases, or tier upgrades. Explain that KEYR progression depends on future eligibility, behavior, and program criteria.`,
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
    const firstName = getFirstName(user);

    let timingContext = null;

    if (
      knowledgeArticle.article_code === "BT_022_TRANSFER_TIMING" ||
      (questionType || "").includes("balance_transfer")
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
      ? `Keeping utilization lower can support financial advancement because it shows the member is using less of their available credit. This member's simulated outside-card utilization is about ${utilization.utilizationPercent.toFixed(
          2
        )}%, so a practical next step is to reduce balances over time while continuing on-time payments. KEYR encourages working toward a low utilization target, such as near 8%, without guaranteeing a credit score increase or tier upgrade.`
      : "Keeping utilization lower can support financial advancement because it shows the member is using less of their available credit. A practical next step is to reduce balances over time while continuing on-time payments. KEYR encourages working toward a low utilization target, such as near 8%, without guaranteeing a credit score increase or tier upgrade.";

  return {
    deterministicShortAnswer: fallbackAnswer,
    deterministicDetailedReasoning:
      `${utilizationText} The member asked about utilization, not balance transfers. Do not recommend a balance transfer unless the member specifically asks about transfers, APR, payoff strategy, or multiple cards. Provide a finished member-facing answer, not instructions.`
  };
}

  if (questionType === "tier_progression") {
    const readinessStatus = memberCoachContext?.calculated_readiness_status || "unknown";
    const currentTier = user?.current_tier || "current";
    const score = memberCoachContext?.credit_score;
    const ascendMinScore = memberCoachContext?.ascend_min_score;
    const nextFocus = memberCoachContext?.next_focus_area || "credit profile";
    const onTimeStatus = memberCoachContext?.on_time_status || "unknown";
    const utilizationStatus = memberCoachContext?.utilization_status || "unknown";

    const readinessLabel = readinessStatus === "nearly_ready"
      ? "nearly ready"
      : readinessStatus === "ready"
        ? "ready"
        : "not yet at the target";

    const deterministicShortAnswer = [
      `Hi ${getFirstName(user) || "there"},`,
      `Based on your simulated profile, you are currently classified as ${readinessLabel} for ${currentTier === "Merit" ? "Ascend" : currentTier}.`,
      `Your on-time payment behavior and utilization indicators are meeting expectations, which are positive advancement signals.`,
      `Your next focus area is your ${nextFocus}. Your simulated score is currently ${score || "unknown"}, while ${currentTier === "Merit" ? "Ascend" : currentTier} readiness begins at ${ascendMinScore || "the target score"}.`,
      `KEYR cannot guarantee advancement or approval decisions, but you appear to be making strong progress toward ${currentTier === "Merit" ? "Ascend" : currentTier} readiness.`
    ].join(" ");

    return {
      deterministicShortAnswer,
      deterministicDetailedReasoning:
        `Member readiness status: ${readinessStatus}. On-time status: ${onTimeStatus}. Utilization status: ${utilizationStatus}. Score: ${score}. Ascend minimum score: ${ascendMinScore}. Next focus area: ${nextFocus}. Do not guarantee approval, underwriting outcomes, credit score increases, or tier upgrades. Explain that KEYR progression depends on future eligibility, behavior, and program criteria.`
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
      `The member is currently in the ${user.current_tier || "current"} tier. Provide a short, helpful KEYR coaching response based on the question. Do not force a balance-transfer recommendation unless the member asks about transfers, APR, payoff, or multiple cards.`,
    deterministicDetailedReasoning:
      "Use the available profile and card context only as background. Keep the response concise, practical, encouraging, and accurate."
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

async function findKnowledgeArticle(pool, question) {
  const cleanQuestion = (question || "").trim();

  if (!cleanQuestion) {
    return null;
  }

  if (isPayFirstQuestion(cleanQuestion)) {
    return getFallbackKnowledgeArticle(cleanQuestion);
  }

  const result = await pool
    .request()
    .input("question", sql.NVarChar(500), cleanQuestion)
    .query(`
      SELECT TOP 1
          a.article_id,
          a.article_code,
          a.title,
          a.approved_answer,
          a.short_answer,
          a.recommended_model,
          a.escalation_required,
          a.human_review_required,
          MAX(q.match_weight) AS best_match_weight
      FROM dbo.AiKnowledgeArticleQuestions q
      INNER JOIN dbo.AiKnowledgeArticles a
          ON q.article_id = a.article_id
      WHERE q.is_active = 1
        AND a.is_active = 1
        AND (
              LOWER(@question) LIKE '%' + LOWER(q.question_text) + '%'
              OR LOWER(q.question_text) LIKE '%' + LOWER(@question) + '%'
              OR LOWER(@question) LIKE '%' + LOWER(a.title) + '%'
              OR LOWER(a.title) LIKE '%' + LOWER(@question) + '%'
              OR LOWER(a.keywords) LIKE '%' + LOWER(@question) + '%'
              OR LOWER(q.keywords) LIKE '%' + LOWER(@question) + '%'
              OR LOWER(@question) LIKE '%pay first%'
              OR LOWER(@question) LIKE '%reduce interest%'
              OR LOWER(@question) LIKE '%interest faster%'
              OR LOWER(@question) LIKE '%which balance%'
              OR LOWER(@question) LIKE '%which card%'
              OR LOWER(@question) LIKE '%highest apr%'
              OR LOWER(q.question_text) LIKE '%pay first%'
              OR LOWER(q.question_text) LIKE '%reduce interest%'
              OR LOWER(q.question_text) LIKE '%highest apr%'
              OR LOWER(q.keywords) LIKE '%pay first%'
              OR LOWER(q.keywords) LIKE '%reduce interest%'
              OR LOWER(q.keywords) LIKE '%highest apr%'
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
      ORDER BY
          best_match_weight DESC,
          a.article_code;
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
  - Example: "Chris, keeping your utilization lower can help support your financial advancement." or "Hi Chris, focusing on on-time payments and lower credit usage can help."
  - Keep the tone warm, encouraging, and proactive while remaining objective and practical.
  - Focus on helping the member act efficiently and make steady progress without sounding overly formal or cold.
  - If the member's first name is not provided, do not invent a name; use direct "you" and "your" language instead.
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

  Response style:
  - Start with the member's first name if available.
  - Use "you" and "your" language throughout the response.
  - Rewrite any wording that uses "the member", "this member", "their", or "they" into direct second-person language such as "you", "your", or "your own".
  - Sound like a helpful financial coach, not a system message.
  - Do not say "the member" in the final answer.
  - Do not expose internal phrases such as "deterministic context," "question type," or "routing reason."

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

If the member first name is provided, the final response MUST begin with that first name in the first sentence.
If the member first name is empty, do not invent a first name.

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
      temperature: 1
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

    const formattedAiShortAnswer = ensureNameGreeting(aiShortAnswer, user?.first_name);

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

      if (cardsResult.recordset.length === 0) {
        return {
          status: 404,
          headers: corsHeaders,
          jsonBody: {
            error: "No external credit cards found for this simulated user."
          }
        };
      }

      if (scenarioResult.recordset.length === 0) {
        return {
          status: 404,
          headers: corsHeaders,
          jsonBody: {
            error: "No balance transfer scenario found for this simulated user."
          }
        };
      }

      const externalCards = cardsResult.recordset;
      const scenario = scenarioResult.recordset[0];
      const knowledgeArticle = await findKnowledgeArticle(pool, question);
      const memberCoachContext = await getMemberCoachContext(
        pool,
        user.sim_user_id
      );

      const routing = chooseModel(question, externalCards.length, knowledgeArticle);
      const plan = buildTransferPlan(externalCards, scenario);

      const coachContext = buildCoachContext({
        questionType: routing.questionType,
        user,
        externalCards,
        scenario,
        plan,
        knowledgeArticle,
        memberCoachContext
      });

      const deterministicShortAnswer = coachContext.deterministicShortAnswer;
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
        knowledgeArticle: coachContext.knowledgeArticleUsed || knowledgeArticle,
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

      const request = pool.request();
      await request
        .input("sim_user_id", sql.UniqueIdentifier, user.sim_user_id)
        .input("sim_bt_scenario_id", sql.UniqueIdentifier, scenario.sim_bt_scenario_id)
        .input("user_question", sql.NVarChar(sql.MAX), question || null)
        .input("scenario_type", sql.NVarChar(100), "balance_transfer_strategy")
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
          user: {
            simUserId: user.sim_user_id,
            name: `${user.first_name} ${user.last_name}`,
            email: user.email,
            currentTier: user.current_tier
          },
          scenario: {
            scenarioName: scenario.scenario_name,
            keyrTier: scenario.keyr_tier,
            transferLimit: Number(scenario.transfer_limit),
            transferFeePercent: Number(scenario.transfer_fee_percent),
            keyrAprPercent: Number(scenario.keyr_apr_percent),
            monthlyPaymentBudget: scenario.monthly_payment_budget
              ? Number(scenario.monthly_payment_budget)
              : null
          },
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
