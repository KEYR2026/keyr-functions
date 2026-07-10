const { app } = require("@azure/functions");
const sql = require("mssql");

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
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

    try {
      const body = await request.json();

      return {
        status: 200,
        headers: corsHeaders,
        jsonBody: {
          success: true,
          message: "AI Financial Coach endpoint is working.",
          received: body
        }
      };
    } catch (error) {
      context.error("simAiFinancialCoach error:", error);

      return {
        status: 500,
        headers: corsHeaders,
        jsonBody: {
          error: "Unable to process AI Financial Coach request.",
          detail: error.message
        }
      };
    }
  }
});