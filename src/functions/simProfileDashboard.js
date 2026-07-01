const { app } = require("@azure/functions");
const sql = require("mssql");

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

app.http("simProfileDashboard", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "sim/profile-dashboard",
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
            example: "/api/sim/profile-dashboard?email=chris.pendingspend@keyr-sim.test"
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
              sim_user_id,
              sim_account_id,
              first_name,
              last_name,
              email,
              current_tier,
              user_goal,
              guidance_level,
              credit_limit,
              posted_balance,
              pending_debits,
              pending_credits,
              projected_balance,
              target_balance,
              projected_utilization_percent,
              recommended_payment_before_close,
              days_until_statement_close,
              days_until_due_date,
              autopay_enabled,
              on_time_status,
              utilization_status,
              credit_score_status,
              readiness_indicator_count,
              calculated_readiness_status,
              next_focus_area,
              dashboard_status,
              dashboard_status_title,
              next_best_action_message
          FROM dbo.vwSimDashboardSummary
          WHERE email = @email;
        `);

      if (!result.recordset || result.recordset.length === 0) {
        return {
          status: 404,
          headers: corsHeaders,
          jsonBody: {
            error: "No simulated profile found for this email.",
            email
          }
        };
      }

      return {
        status: 200,
        headers: corsHeaders,
        jsonBody: {
          profile: result.recordset[0]
        }
      };
    } catch (error) {
      context.error("simProfileDashboard error:", error);

      return {
        status: 500,
        headers: corsHeaders,
        jsonBody: {
          error: "Unable to load simulated profile dashboard."
        }
      };
    } finally {
      if (pool) {
        await pool.close();
      }
    }
  }
});