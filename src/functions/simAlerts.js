const { app } = require("@azure/functions");
const sql = require("mssql");

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

app.http("simAlerts", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "sim/alerts",
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
            example: "/api/sim/alerts?email=chris.pendingspend@keyr-sim.test"
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
          SELECT
              a.sim_alert_id,
              a.sim_user_id,
              a.sim_account_id,
              u.first_name,
              u.last_name,
              u.email,
              a.alert_type,
              a.severity,
              a.title,
              a.message,
              a.recommended_amount,
              a.action_label,
              a.action_url,
              a.is_read,
              a.delivered_email,
              a.delivered_push,
              a.delivered_sms,
              a.created_at_utc
          FROM dbo.SimAlerts a
          JOIN dbo.SimUsers u
              ON a.sim_user_id = u.sim_user_id
          WHERE u.email = @email
          ORDER BY
              CASE a.severity
                  WHEN 'red' THEN 1
                  WHEN 'yellow' THEN 2
                  WHEN 'green' THEN 3
                  ELSE 4
              END,
              a.created_at_utc DESC;
        `);

      return {
        status: 200,
        headers: corsHeaders,
        jsonBody: {
          alerts: result.recordset || []
        }
      };
    } catch (error) {
      context.error("simAlerts error:", error);

      return {
        status: 500,
        headers: corsHeaders,
        jsonBody: {
          error: "Unable to load simulated alerts."
        }
      };
    } finally {
      if (pool) {
        await pool.close();
      }
    }
  }
});