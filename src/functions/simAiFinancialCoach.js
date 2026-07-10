const { app } = require("@azure/functions");
const sql = require("mssql");

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function chooseModel(question, cardCount) {
  const q = (question || "").toLowerCase();

  if (
    cardCount >= 2 ||
    q.includes("which") ||
    q.includes("best strategy") ||
    q.includes("what should i do") ||
    q.includes("focus on") ||
    q.includes("reduce faster") ||
    q.includes("transfer from each") ||
    q.includes("split it") ||
    q.includes("three cards") ||
    q.includes("multiple cards")
  ) {
    return {
      model: "mai-thinking-1",
      reason: "Debt strategy involves multiple cards or prioritization logic."
    };
  }

  return {
    model: "gpt-5-mini",
    reason: "Simple coaching or explanation."
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

  const transferFee = totalTransferred * (transferFeePercent / 100);

  const highestAprCard = allocations[0];

  const recommendedStrategy = "highest_apr_first";

  const recommendedCardLabel = highestAprCard
    ? highestAprCard.cardLabel
    : null;

  const recommendedTransferAmount = highestAprCard
    ? highestAprCard.transferAmount
    : 0;

  const shortAnswer = highestAprCard
    ? `Transfer $${totalTransferred.toFixed(
        2
      )} starting with ${highestAprCard.cardLabel}, which has the highest APR at ${highestAprCard.aprPercent.toFixed(
        2
      )}%. This maximizes interest savings by moving debt away from the most expensive balance first.`
    : "No transfer recommendation is available because no external card balances were found.";

  const detailedReasoning = highestAprCard
    ? `KEYR recommends applying the available balance transfer amount to the highest APR debt first. This approach generally reduces interest burden faster than splitting the transfer across lower APR cards. The total transfer amount is $${totalTransferred.toFixed(
        2
      )}, the estimated transfer fee is $${transferFee.toFixed(
        2
      )}, and the KEYR APR for this scenario is ${keyrApr.toFixed(
        2
      )}%. After completing the transfer, extra payments should continue toward the highest remaining APR balance.`
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

app.http("simAiFinancialCoach", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "sim/ai-financial-coach",

  handler: async (request, context) => {
    const corsHeaders = getCorsHeaders();

    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers: corsHeaders
      };
    }

    let pool;

    try {
      const body = await request.json();

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

      await pool
        .request()
        .input("sim_user_id", sql.UniqueIdentifier, user.sim_user_id)
        .input(
          "sim_bt_scenario_id",
          sql.UniqueIdentifier,
          scenario.sim_bt_scenario_id
        )
        .input("user_question", sql.NVarChar(sql.MAX), question || null)
        .input("scenario_type", sql.NVarChar(100), "balance_transfer_strategy")
        .input(
          "recommended_strategy",
          sql.NVarChar(100),
          plan.recommendedStrategy
        )
        .input(
          "recommended_card_label",
          sql.NVarChar(100),
          plan.recommendedCardLabel
        )
        .input(
          "recommended_transfer_amount",
          sql.Decimal(18, 2),
          plan.recommendedTransferAmount
        )
        .input("model_selected", sql.NVarChar(100), routing.model)
        .input("routing_reason", sql.NVarChar(500), routing.reason)
        .input("short_answer", sql.NVarChar(sql.MAX), plan.shortAnswer)
        .input(
          "detailed_reasoning",
          sql.NVarChar(sql.MAX),
          plan.detailedReasoning
        )
        .query(`
          INSERT INTO dbo.SimAiFinancialCoachResults (
            sim_user_id,
            sim_bt_scenario_id,
            user_question,
            scenario_type,
            recommended_strategy,
            recommended_card_label,
            recommended_transfer_amount,
            model_selected,
            routing_reason,
            short_answer,
            detailed_reasoning
          )
          VALUES (
            @sim_user_id,
            @sim_bt_scenario_id,
            @user_question,
            @scenario_type,
            @recommended_strategy,
            @recommended_card_label,
            @recommended_transfer_amount,
            @model_selected,
            @routing_reason,
            @short_answer,
            @detailed_reasoning
          );
        `);

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
          routing,
          recommendation: {
            recommendedStrategy: plan.recommendedStrategy,
            recommendedCardLabel: plan.recommendedCardLabel,
            recommendedTransferAmount: plan.recommendedTransferAmount,
            totalTransferred: plan.totalTransferred,
            transferFee: plan.transferFee,
            allocations: plan.allocations,
            shortAnswer: plan.shortAnswer,
            detailedReasoning: plan.detailedReasoning
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
          detail: error.message
        }
      };
    } finally {
      if (pool) {
        await pool.close();
      }
    }
  }
});