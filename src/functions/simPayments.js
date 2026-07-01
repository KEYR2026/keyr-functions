const { app } = require("@azure/functions");
const sql = require("mssql");

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

app.http("simPayments", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "sim/payments",
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
      const email = request.query.get("email");

      if (!email || !email.includes("@")) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            error: "Missing or invalid email query parameter.",
            example: "/api/sim/payments?email=chris.pendingspend@keyr-sim.test"
          }
        };
      }

      const connectionString = process.env.KEYR_DB_CONNECTION;

      if (!connectionString) {
        return {
          status: 500,
          headers: corsHeaders,
          jsonBody: {
            error: "KEYR_DB_CONNECTION environment variable is not configured."
          }
        };
      }

      pool = await sql.connect(connectionString);

      const result = await pool
        .request()
        .input("email", sql.NVarChar(255), email)
        .query(`
          SELECT TOP 1
              sim_account_id,
              sim_user_id,
              first_name,
              last_name,
              email,
              current_tier,
              user_goal,
              guidance_level,
              credit_limit,
              posted_balance,
              available_credit,
              apr,
              statement_close_date,
              payment_due_date,
              minimum_due,
              autopay_enabled,
              autopay_type,
              target_utilization_percent,
              target_balance,
              pending_debits,
              pending_credits,
              projected_balance,
              projected_utilization_percent,
              recommended_payment_before_close,
              days_until_statement_close,
              days_until_due_date
          FROM dbo.vwSimAccountGuidance
          WHERE email = @email;
        `);

      if (!result.recordset || result.recordset.length === 0) {
        return {
          status: 404,
          headers: corsHeaders,
          jsonBody: {
            error: "No simulated payment guidance found for this email.",
            email
          }
        };
      }

      return {
        status: 200,
        headers: corsHeaders,
        jsonBody: {
          payments: result.recordset[0]
        }
      };
    } catch (error) {
      context.error("simPayments error:", error);

      return {
        status: 500,
        headers: corsHeaders,
        jsonBody: {
          error: "Unable to load simulated payment guidance."
        }
      };
    } finally {
      if (pool) {
        await pool.close();
      }
    }
  }
});