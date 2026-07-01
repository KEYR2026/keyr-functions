const { app } = require("@azure/functions");
const sql = require("mssql");

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

app.http("simProgress", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "sim/progress",
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
            receivedEmail: email || null,
            example: "/api/sim/progress?email=chris.pendingspend%40keyr-sim.test"
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
              sim_readiness_id,
              sim_user_id,
              sim_account_id,
              first_name,
              last_name,
              email,
              current_tier,
              on_time_cycles_completed,
              on_time_cycles_required,
              on_time_status,
              avg_utilization_percent,
              utilization_target_percent,
              utilization_status,
              credit_score,
              ascend_min_score,
              apex_min_score,
              credit_score_status,
              readiness_indicator_count,
              calculated_readiness_status,
              next_focus_area
          FROM dbo.vwSimReadinessSummary
          WHERE email = @email;
        `);

      if (!result.recordset || result.recordset.length === 0) {
        return {
          status: 404,
          headers: corsHeaders,
          jsonBody: {
            error: "No simulated progress profile found for this email.",
            email
          }
        };
      }

      return {
        status: 200,
        headers: corsHeaders,
        jsonBody: {
          progress: result.recordset[0]
        }
      };
    } catch (error) {
      context.error("simProgress error:", error);

      return {
        status: 500,
        headers: corsHeaders,
        jsonBody: {
          error: "Unable to load simulated progress data."
        }
      };
    } finally {
      if (pool) {
        await pool.close();
      }
    }
  }
});