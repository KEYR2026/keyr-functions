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
      const email = request.query && request.query.email;

      if (!email || !email.includes("@")) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            error: "Missing or invalid email query parameter",
            example: "/api/sim/progress?email=chris.pendingspend@keyr-sim.test"
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
        .query(`SELECT TOP 1 * FROM dbo.vwSimReadinessSummary WHERE email = @email;`);

      if (!result.recordset || result.recordset.length === 0) {
        return {
          status: 404,
          headers: corsHeaders,
          jsonBody: {
            error: "No simulated progress profile found for this email",
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
        headers: getCorsHeaders(),
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