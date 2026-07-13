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
  return (endpoint || "").replace(/\/+$/, "");
}

function chooseModel(question, cardCount) {
  const q = (question || "").toLowerCase();

  const deepKeywords = [
    "which card",
    "what card",
    "best strategy",
    "what should i do",
    "focus on",
    "reduce faster",
    "transfer from each",
    "split it",
    "three cards",
    "multiple cards",
    "multi-card",
    "multi card",
    "several cards",
    "balance transfer",
    "transfer",
    "apr",
    "interest",
    "payoff",
    "pay off",
    "pay down",
    "debt reduction",
    "debt strategy",
    "snowball",
    "avalanche",
    "consolidate",
    "consolidation",
    "ascend",
    "apex",
    "12 month",
    "six month",
    "6 month",
    "monthly plan",
    "payment plan"
  ];

  const isDeepQuestion =
    deepKeywords.some((word) => q.includes(word)) || Number(cardCount || 0) >= 3;

  if (isDeepQuestion) {
    return {
      model: deepDeployment,
      modelFamily: "DeepSeek-V4-Pro",
      reason:
        "Debt strategy involves APR, payoff, transfer, tier progression, consolidation, or multi-card logic."
    };
  }

  return {
    model: fastDeployment,
    modelFamily: "gpt-5-mini",
    reason: "Simple coaching or explanation routed to fast, low-cost model."
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

async function generateAiCoachAnswer({
  deployment,
  question,
  deterministicShortAnswer,
  deterministicDetailedReasoning,
  user,
  externalCards,
  scenario,
  routingReason
}) {
  if (!azureAiEndpoint || !azureAiApiKey) {
    return {
      aiWasUsed: false,
      aiError: "Azure AI endpoint or API key is missing.",
      shortAnswer: deterministicShortAnswer
    };
  }

  const cleanEndpoint = normalizeEndpoint(azureAiEndpoint);
  const url = `${cleanEndpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(azureAiApiVersion)}`;

  const systemMessage = `
You are KEYR's AI Financial Coach.

KEYR is a financial advancement platform that helps members reduce revolving debt,
improve utilization, understand balance transfer options, and progress toward better financial tiers.

Rules:
- Use KEYR deterministic calculations as the source of truth.
- Do not invent balances, APRs, credit limits, payments, scores, approval odds, or payoff timelines.
- Do not guarantee credit score increases, approvals, underwriting results, or tier upgrades.
- Do not give legal, tax, bankruptcy, investment, or formal credit-repair advice.
- Keep the response practical, clear, encouraging, and member-friendly.
- If the member asks about hardship, fraud, disputes, collections, lawsuits, bankruptcy, or legal issues, recommend contacting KEYR support.
- If the deterministic transfer recommendation is unrelated to the member's question, answer the member's question generally and do not force the balance transfer recommendation.
- Keep the response under 125 words unless the member specifically asks for a detailed plan.
`;

  const userMessage = `
Member question:
${question || "No specific question provided."}

Routing reason:
${routingReason}

KEYR deterministic short recommendation:
${deterministicShortAnswer}

KEYR deterministic detailed reasoning:
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
`;

  try {
    const aiResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": azureAiApiKey
      },
      body: JSON.stringify({
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
        temperature: 0.3,
        max_tokens: 250
      })
    });

    const responseText = await aiResponse.text();

    if (!aiResponse.ok) {
      return {
        aiWasUsed: false,
        aiError: `Azure AI call failed with status ${aiResponse.status}: ${responseText}`,
        shortAnswer: deterministicShortAnswer
      };
    }

    const parsed = JSON.parse(responseText);
    const aiShortAnswer = parsed?.choices?.[0]?.message?.content?.trim() || deterministicShortAnswer;

    return {
      aiWasUsed: true,
      aiError: null,
      shortAnswer: aiShortAnswer
    };
  } catch (error) {
    return {
      aiWasUsed: false,
      aiError: error?.message || "Azure AI call failed.",
      shortAnswer: deterministicShortAnswer
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

      const routing = chooseModel(question, externalCards.length);
      const plan = buildTransferPlan(externalCards, scenario);
      const deterministicShortAnswer = plan.shortAnswer;
      const deterministicDetailedReasoning = plan.detailedReasoning;

      const aiResult = await generateAiCoachAnswer({
        deployment: routing.model,
        question,
        deterministicShortAnswer,
        deterministicDetailedReasoning,
        user,
        externalCards,
        scenario,
        routingReason: routing.reason
      });

      const finalShortAnswer = aiResult.shortAnswer || deterministicShortAnswer;

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
            reason: routing.reason,
            aiWasUsed: aiResult.aiWasUsed,
            aiError: aiResult.aiError
          },
          recommendation: {
            recommendedStrategy: plan.recommendedStrategy,
            recommendedCardLabel: plan.recommendedCardLabel,
            recommendedTransferAmount: plan.recommendedTransferAmount,
            totalTransferred: plan.totalTransferred,
            transferFee: plan.transferFee,
            allocations: plan.allocations,
            deterministicShortAnswer,
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
