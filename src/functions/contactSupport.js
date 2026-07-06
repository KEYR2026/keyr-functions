const { app } = require("@azure/functions");
const sql = require("mssql");

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function normalizeText(value) {
  return (value || "").toLowerCase().trim().replace(/\s+/g, " ");
}

function getCategoryResponse(category, comparisonType) {
  const normalized = normalizeText(category);
  const normalizedComparison = normalizeText(comparisonType);

  const defaultResponse = {
    category: "General Question",
    subject: "KEYR received your message",
    links: [
      { label: "Visit KEYR", url: "https://www.keyr.co/" },
      { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
      { label: "Debt Reduction Model", url: "https://www.keyr.co/debt-reduction-model.html" }
    ],
    message:
      "Thank you for contacting KEYR. Your message has been received. Our team will review your submission and follow up if needed."
  };

  if (normalized === "tier comparison question") {
    const comparisonResponses = {
      "smart start vs anchor base": {
        category: "Tier Comparison Question",
        subject: "KEYR received your Smart Start vs Anchor Base question",
        links: [
          { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
          { label: "How KEYR Works", url: "https://www.keyr.co/how-it-works.html" },
          { label: "FAQ", url: "https://www.keyr.co/faq.html" }
        ],
        message:
          "Smart Start is designed as an entry pathway for users who are beginning their credit journey and need education, structure, and responsible guidance. Anchor Base is designed as a more structured secured starting point for users who may need a foundational credit-building path backed by a deposit. Smart Start helps users begin safely, while Anchor Base provides a stronger secured foundation for users ready to begin building with more structure."
      },
      "anchor base vs anchor": {
        category: "Tier Comparison Question",
        subject: "KEYR received your Anchor Base vs Anchor question",
        links: [
          { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
          { label: "FAQ", url: "https://www.keyr.co/faq.html" }
        ],
        message:
          "Anchor Base is the foundational secured starting point for users who may need the safest entry into KEYR's credit-building path. Anchor is a stronger secured pathway for users who are ready for more structure and may be further along in their financial readiness. Both are designed to help users build responsible habits, but Anchor generally represents a step above Anchor Base in readiness and progression."
      },
      "anchor vs merit": {
        category: "Tier Comparison Question",
        subject: "KEYR received your Anchor vs Merit question",
        links: [
          { label: "Debt Reduction Model", url: "https://www.keyr.co/debt-reduction-model.html" },
          { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
          { label: "FAQ", url: "https://www.keyr.co/faq.html" }
        ],
        message:
          "Anchor is designed as a secured credit-building pathway focused on helping users establish consistency and responsible habits. Merit is designed as a stronger advancement pathway for users who may be ready for more structured benefits, lower-cost borrowing opportunities, and debt reduction support. Many users may begin with Anchor and progress toward Merit as payment behavior, utilization control, and readiness indicators improve."
      },
      "merit vs ascend": {
        category: "Tier Comparison Question",
        subject: "KEYR received your Merit vs Ascend question",
        links: [
          { label: "Debt Reduction Model", url: "https://www.keyr.co/debt-reduction-model.html" },
          { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
          { label: "FAQ", url: "https://www.keyr.co/faq.html" }
        ],
        message:
          "Merit is designed as a structured advancement and debt reduction pathway, typically suited for users who are building or rebuilding with responsible behavior. Ascend is intended as a higher advancement pathway that may involve stronger eligibility requirements and a more established readiness profile. Merit helps users build toward stronger opportunities, while Ascend is designed for users who may already demonstrate stronger financial readiness."
      },
      "ascend vs apex": {
        category: "Tier Comparison Question",
        subject: "KEYR received your Ascend vs Apex question",
        links: [
          { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
          { label: "FAQ", url: "https://www.keyr.co/faq.html" }
        ],
        message:
          "Ascend is an advanced KEYR pathway for users who demonstrate strong financial readiness and responsible credit behavior. Apex is KEYR's highest advancement pathway and is intended for users with the strongest overall profile, readiness indicators, and eligibility alignment. Ascend represents advanced progression, while Apex represents KEYR's premium advancement level. All higher-tier decisions remain subject to sponsor-bank review, eligibility requirements, and applicable terms."
      }
    };

    return comparisonResponses[normalizedComparison] || {
      category: "Tier Comparison Question",
      subject: "KEYR received your tier comparison question",
      links: [
        { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
        { label: "FAQ", url: "https://www.keyr.co/faq.html" }
      ],
      message:
        "Thank you for your KEYR tier comparison question. KEYR pathways are designed to help users start safely, build confidence, and advance over time based on readiness, responsible behavior, and applicable eligibility requirements."
    };
  }

  const responses = {
    "starting path check": {
      category: "Starting Path Check",
      subject: "KEYR received your Starting Path Check question",
      links: [
        { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
        { label: "How KEYR Works", url: "https://www.keyr.co/how-it-works.html" },
        { label: "Debt Reduction Model", url: "https://www.keyr.co/debt-reduction-model.html" }
      ],
      message:
        "Thank you for your question about the KEYR Starting Path Check. This tool helps identify which KEYR pathway may best fit a user's current financial position and goals."
    },
    "debt reduction model": {
      category: "Debt Reduction Model",
      subject: "KEYR received your Debt Reduction Model question",
      links: [
        { label: "Debt Reduction Model", url: "https://www.keyr.co/debt-reduction-model.html" },
        { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" }
      ],
      message:
        "Thank you for your question about the KEYR Debt Reduction Model. This model is designed to help users understand how lower-rate pathways, structured payments, and responsible credit behavior may help reduce debt burden over time."
    },
    "smart start": {
      category: "Smart Start",
      subject: "KEYR received your Smart Start question",
      links: [
        { label: "How KEYR Works", url: "https://www.keyr.co/how-it-works.html" },
        { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" }
      ],
      message:
        "Thank you for your question about Smart Start. Smart Start is designed as an entry pathway for users who are beginning their financial journey and want education, guidance, and responsible credit-building support."
    },
    "anchor / anchor base": {
      category: "Anchor / Anchor Base",
      subject: "KEYR received your Anchor question",
      links: [
        { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
        { label: "Debt Reduction Model", url: "https://www.keyr.co/debt-reduction-model.html" }
      ],
      message:
        "Thank you for your question about Anchor or Anchor Base. These pathways are designed to help users build a stronger financial foundation through safer starting options and structured guidance."
    },
    merit: {
      category: "Merit",
      subject: "KEYR received your Merit question",
      links: [
        { label: "Debt Reduction Model", url: "https://www.keyr.co/debt-reduction-model.html" },
        { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" }
      ],
      message:
        "Thank you for your question about Merit. Merit is designed for users seeking a structured advancement pathway, responsible credit-building support, and potential debt reduction guidance."
    },
    ascend: {
      category: "Ascend",
      subject: "KEYR received your Ascend question",
      links: [
        { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
        { label: "How KEYR Works", url: "https://www.keyr.co/how-it-works.html" }
      ],
      message:
        "Thank you for your question about Ascend. Ascend is intended as a higher advancement pathway subject to eligibility, account review, and applicable program requirements."
    },
    apex: {
      category: "Apex",
      subject: "KEYR received your Apex question",
      links: [
        { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
        { label: "How KEYR Works", url: "https://www.keyr.co/how-it-works.html" }
      ],
      message:
        "Thank you for your question about Apex. Apex is intended as KEYR's highest advancement pathway and will be subject to eligibility, account review, and applicable program requirements."
    },
    "which keyr path fits me?": {
      category: "Which KEYR Path Fits Me?",
      subject: "KEYR received your pathway question",
      links: [
        { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
        { label: "How KEYR Works", url: "https://www.keyr.co/how-it-works.html" },
        { label: "FAQ", url: "https://www.keyr.co/faq.html" }
      ],
      message:
        "Thank you for asking which KEYR path may fit you. The best next step is to complete the Starting Path Check, which helps identify whether Smart Start, Anchor Base, Anchor, Merit, Ascend, or Apex may be the better starting point based on your current goals and readiness."
    },
    "application status": {
      category: "Application Status",
      subject: "KEYR received your application status question",
      links: [
        { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" }
      ],
      message:
        "Thank you for your application status question. KEYR is currently preparing future application and member portal experiences. If you submitted information, our team will review and follow up as appropriate."
    },
    "payment guidance": {
      category: "Payment Guidance",
      subject: "KEYR received your payment guidance question",
      links: [
        { label: "Debt Reduction Model", url: "https://www.keyr.co/debt-reduction-model.html" },
        { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" }
      ],
      message:
        "Thank you for your payment guidance question. KEYR is designed to help users understand payment timing, utilization, statement close dates, and responsible financial habits."
    },
    "credit building education": {
      category: "Credit Building Education",
      subject: "KEYR received your credit education question",
      links: [
        { label: "Starting Path Check", url: "https://www.keyr.co/survey.html" },
        { label: "Debt Reduction Model", url: "https://www.keyr.co/debt-reduction-model.html" }
      ],
      message:
        "Thank you for your credit-building education question. KEYR is designed to help users understand credit behavior, utilization, payment consistency, and responsible advancement."
    },
    "partnership inquiry": {
      category: "Partnership Inquiry",
      subject: "KEYR received your partnership inquiry",
      links: [
        { label: "Visit KEYR", url: "https://www.keyr.co/" }
      ],
      message:
        "Thank you for your partnership inquiry. KEYR is open to conversations with organizations aligned to financial education, responsible credit-building, debt reduction, and community advancement."
    },
    "media inquiry": {
      category: "Media Inquiry",
      subject: "KEYR received your media inquiry",
      links: [
        { label: "Visit KEYR", url: "https://www.keyr.co/" }
      ],
      message:
        "Thank you for contacting KEYR regarding a media inquiry. Your message has been received and will be reviewed."
    },
    "grant / sponsorship inquiry": {
      category: "Grant / Sponsorship Inquiry",
      subject: "KEYR received your grant or sponsorship inquiry",
      links: [
        { label: "Visit KEYR", url: "https://www.keyr.co/" },
        { label: "Debt Reduction Model", url: "https://www.keyr.co/debt-reduction-model.html" }
      ],
      message:
        "Thank you for contacting KEYR regarding grant or sponsorship opportunities. KEYR is focused on financial advancement, responsible credit-building, debt reduction guidance, and community impact."
    },
    "technical support": {
      category: "Technical Support",
      subject: "KEYR received your technical support question",
      links: [
        { label: "Visit KEYR", url: "https://www.keyr.co/" }
      ],
      message:
        "Thank you for contacting KEYR technical support. Please include the page, device, browser, and any error message if additional follow-up is needed."
    },
    "privacy / data question": {
      category: "Privacy / Data Question",
      subject: "KEYR received your privacy or data question",
      links: [
        { label: "Visit KEYR", url: "https://www.keyr.co/" }
      ],
      message:
        "Thank you for your privacy or data question. KEYR is designed to collect only information needed to support user education, engagement, and future program readiness."
    }
  };

  return responses[normalized] || defaultResponse;
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.http("contactSupport", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "contact/support",
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

      const firstName = (body.firstName || "").trim();
      const lastName = (body.lastName || "").trim();
      const email = (body.email || "").trim();
      const phone = (body.phone || "").trim();
      const category = (body.category || "").trim();
      const comparisonType = (body.comparisonType || "").trim();
      const subject = (body.subject || "").trim();
      const message = (body.message || "").trim();
      const wantsUpdates = body.wantsUpdates === true;
      const sourcePage = (body.sourcePage || "").trim();

      if (!firstName || !email || !category || !message) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            error: "Missing required fields. First name, email, category, and message are required."
          }
        };
      }

      if (category === "Tier Comparison Question" && !comparisonType) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            error: "Please select which KEYR tiers you want to compare."
          }
        };
      }

      if (!isValidEmail(email)) {
        return {
          status: 400,
          headers: corsHeaders,
          jsonBody: {
            error: "Invalid email address."
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

      const categoryResponse = getCategoryResponse(category, comparisonType);

      pool = await sql.connect(connectionString);

      await pool
        .request()
        .input("first_name", sql.NVarChar(100), firstName)
        .input("last_name", sql.NVarChar(100), lastName || null)
        .input("email", sql.NVarChar(255), email)
        .input("phone", sql.NVarChar(50), phone || null)
        .input("category", sql.NVarChar(100), category)
        .input("comparison_type", sql.NVarChar(150), comparisonType || null)
        .input("subject", sql.NVarChar(200), subject || null)
        .input("message", sql.NVarChar(sql.MAX), message)
        .input("wants_updates", sql.Bit, wantsUpdates)
        .input("auto_response_sent", sql.Bit, true)
        .input("auto_response_category", sql.NVarChar(100), categoryResponse.category)
        .input("source_page", sql.NVarChar(200), sourcePage || null)
        .input("user_agent", sql.NVarChar(500), request.headers.get("user-agent") || null)
        .query(`
          INSERT INTO dbo.ContactSupportSubmissions (
              first_name,
              last_name,
              email,
              phone,
              category,
              comparison_type,
              subject,
              message,
              wants_updates,
              auto_response_sent,
              auto_response_category,
              source_page,
              user_agent
          )
          VALUES (
              @first_name,
              @last_name,
              @email,
              @phone,
              @category,
              @comparison_type,
              @subject,
              @message,
              @wants_updates,
              @auto_response_sent,
              @auto_response_category,
              @source_page,
              @user_agent
          );
        `);

      return {
        status: 200,
        headers: corsHeaders,
        jsonBody: {
          success: true,
          acknowledgement: {
            subject: categoryResponse.subject,
            message: categoryResponse.message,
            links: categoryResponse.links
          }
        }
      };
    } catch (error) {
      context.error("contactSupport error:", error);

      return {
        status: 500,
        headers: corsHeaders,
        jsonBody: {
          error: "Unable to submit contact request."
        }
      };
    } finally {
      if (pool) {
        await pool.close();
      }
    }
  }
});
