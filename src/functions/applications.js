const { app } = require("@azure/functions");
const sql = require("mssql");

// ------------------------------
// Security / normalization helpers
// ------------------------------
function cleanText(value, maxLength = 200) {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanDigits(value, maxLength = 10) {
  return String(value ?? "")
    .replace(/\D/g, "")
    .slice(0, maxLength);
}

function cleanInt(value) {
  if (value === undefined || value === null || value === "") return null;

  const cleaned = String(value).replace(/[^0-9]/g, "");
  if (!cleaned) return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function cleanMoney(value) {
  if (value === undefined || value === null || value === "") return null;

  const cleaned = String(value).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function cleanDate(value) {
  if (!value) return null;

  const compact = cleanText(value, 20);
  const d = new Date(`${compact}T12:00:00Z`);

  return Number.isNaN(d.getTime()) ? null : d;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function isAllowed(value, allowedValues) {
  if (!value) return true;
  return allowedValues.includes(value);
}

function normalizePayload(data) {
  const payload = {
    // base fields
    source: cleanText(data.source, 50),
    tier: cleanText(data.tier, 80),
    depositAmount: cleanInt(data.depositAmount),
    autopayPref: cleanText(data.autopayPref, 50),
    planGoal: cleanText(data.planGoal, 255),
    balanceTransferIntent: cleanText(data.balanceTransferIntent, 255),
    housingStatus: cleanText(data.housingStatus, 50),
    housingPayment: cleanMoney(data.housingPayment),
    incomeRange: cleanText(data.incomeRange, 80),
    contactPref: cleanText(data.contactPref, 50),

    // identity / master fields
    firstName: cleanText(data.firstName, 50),
    middleName: cleanText(data.middleName, 50),
    lastName: cleanText(data.lastName, 50),
    suffix: cleanText(data.suffix, 10),
    displayName: cleanText(data.displayName, 160),
    email: cleanText(data.email, 120) || null,
    stateCode: cleanText(data.stateCode, 10),
    requestedStartMode: cleanText(data.requestedStartMode, 30),
    requestedDepositIntent: cleanText(data.requestedDepositIntent, 100),

    // combined fields
    dob: cleanDate(data.dob),
    ssnLast4: cleanDigits(data.ssnLast4, 4),
    addressLine1: cleanText(data.addressLine1, 120),
    addressLine2: cleanText(data.addressLine2, 120),
    city: cleanText(data.city, 80),
    zip: cleanText(data.zip, 15),
    phoneMobile: cleanText(data.phoneMobile, 25),
    phoneHome: cleanText(data.phoneHome, 25),

    // requested / journey fields
    requestedTier: cleanText(data.requestedTier || data.tier, 80),
    requestedGoal: cleanText(data.requestedGoal || data.planGoal, 255),
    requestedBalanceTransferIntent: cleanText(
      data.requestedBalanceTransferIntent || data.balanceTransferIntent,
      255
    ),

    currentStatus: "submitted",
    currentStage: "apply_submitted",
    status: "submitted"
  };

  return payload;
}

function validatePayload(payload) {
  const allowedStartModes = ["credit", "safe", "secured", "smartstart", "Smart Start", "Start Secured"];
  const allowedTiers = [
    "Anchor Base",
    "Anchor",
    "Anchor (Secured)",
    "Merit",
    "Merit (Secured)",
    "Ascend",
    "Ascend (Unsecured)",
    "Apex",
    "Apex (Unsecured)"
  ];

  if (!payload.source) {
    return "Missing source.";
  }

  if (!payload.tier) {
    return "Missing tier.";
  }

  if (!payload.firstName) {
    return "Missing firstName.";
  }

  if (!payload.lastName) {
    return "Missing lastName.";
  }

  if (typeof payload.email !== "string" || payload.email.trim() === "" || !isValidEmail(payload.email)) {
    return "Invalid email.";
  }

  if (!/^\d{4}$/.test(payload.ssnLast4)) {
    return "Invalid ssnLast4.";
  }

  if (payload.requestedStartMode && !isAllowed(payload.requestedStartMode, allowedStartModes)) {
    return "Invalid requestedStartMode.";
  }

  if (payload.tier && !isAllowed(payload.tier, allowedTiers)) {
    return "Invalid tier.";
  }

  if (payload.requestedTier && !isAllowed(payload.requestedTier, allowedTiers)) {
    return "Invalid requestedTier.";
  }

  return null;
}

function buildCorsHeaders(origin) {
  const allowedOrigins = new Set([
    "https://keyr.co",
    "https://www.keyr.co",
    "http://localhost:4280",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
  ]);

  const allowedOrigin = allowedOrigins.has(origin)
    ? origin
    : "https://www.keyr.co";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  };
}

// ------------------------------
// Function endpoint
// ------------------------------
app.http("applications", {
  methods: ["OPTIONS", "POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const origin = request.headers.get("origin") || "";
    const headers = buildCorsHeaders(origin);

    if (request.method === "OPTIONS") {
      return {
        status: 204,
        headers
      };
    }

    if (request.method !== "POST") {
      return {
        status: 405,
        headers,
        jsonBody: {
          error: "Method not allowed."
        }
      };
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 25000) {
      return {
        status: 413,
        headers,
        jsonBody: {
          error: "Payload too large."
        }
      };
    }

    let data;

    try {
      data = await request.json();
    } catch (_) {
      return {
        status: 400,
        headers,
        jsonBody: {
          error: "Invalid JSON body."
        }
      };
    }

    const payload = normalizePayload(data);
    const validationError = validatePayload(payload);

    if (validationError) {
      return {
        status: 400,
        headers,
        jsonBody: {
          error: validationError
        }
      };
    }

    const conn = process.env.KEYR_DB_CONNECTION;

    if (!conn) {
      context.log.error("KEYR_DB_CONNECTION is missing.");

      return {
        status: 500,
        headers,
        jsonBody: {
          error: "Application service is not configured."
        }
      };
    }

    try {
      const pool = await sql.connect(conn);

      const result = await pool.request()
        // existing/base fields
        .input("source", sql.VarChar(50), payload.source)
        .input("tier", sql.VarChar(80), payload.tier)
        .input("depositAmount", sql.Int, payload.depositAmount)
        .input("autopayPref", sql.VarChar(50), payload.autopayPref || null)
        .input("planGoal", sql.VarChar(255), payload.planGoal || null)
        .input("balanceTransferIntent", sql.VarChar(255), payload.balanceTransferIntent || null)
        .input("housingStatus", sql.VarChar(50), payload.housingStatus || null)
        .input("housingPayment", sql.Decimal(10, 2), payload.housingPayment)
        .input("incomeRange", sql.VarChar(80), payload.incomeRange || null)
        .input("contactPref", sql.VarChar(50), payload.contactPref || null)

        // identity / master fields
        .input("firstName", sql.VarChar(50), payload.firstName)
        .input("middleName", sql.VarChar(50), payload.middleName || null)
        .input("lastName", sql.VarChar(50), payload.lastName)
        .input("suffix", sql.VarChar(10), payload.suffix || null)
        .input("displayName", sql.VarChar(160), payload.displayName || null)
        .input("email", sql.VarChar(120), payload.email)
        .input("stateCode", sql.VarChar(10), payload.stateCode || null)
        .input("requestedStartMode", sql.VarChar(30), payload.requestedStartMode || null)
        .input("requestedDepositIntent", sql.VarChar(100), payload.requestedDepositIntent || null)

        // newly added combined fields
        .input("dob", sql.Date, payload.dob)
        .input("ssnLast4", sql.VarChar(4), payload.ssnLast4)
        .input("addressLine1", sql.VarChar(120), payload.addressLine1 || null)
        .input("addressLine2", sql.VarChar(120), payload.addressLine2 || null)
        .input("city", sql.VarChar(80), payload.city || null)
        .input("zip", sql.VarChar(15), payload.zip || null)
        .input("phoneMobile", sql.VarChar(25), payload.phoneMobile || null)
        .input("phoneHome", sql.VarChar(25), payload.phoneHome || null)

        // requested / journey fields
        .input("requestedTier", sql.VarChar(80), payload.requestedTier || payload.tier)
        .input("requestedGoal", sql.VarChar(255), payload.requestedGoal || null)
        .input(
          "requestedBalanceTransferIntent",
          sql.VarChar(255),
          payload.requestedBalanceTransferIntent || null
        )
        .input("currentStatus", sql.VarChar(50), payload.currentStatus)
        .input("currentStage", sql.VarChar(50), payload.currentStage)
        .input("status", sql.VarChar(50), payload.status)

        .query(`
          INSERT INTO Applications (
            journeyId,
            source,
            tier,
            depositAmount,
            autopayPref,
            planGoal,
            balanceTransferIntent,
            housingStatus,
            housingPayment,
            incomeRange,
            contactPref,
            status,

            firstName,
            middleName,
            lastName,
            suffix,
            displayName,
            email,
            stateCode,
            requestedStartMode,
            requestedDepositIntent,

            dob,
            ssnLast4,
            addressLine1,
            addressLine2,
            city,
            zip,
            phoneMobile,
            phoneHome,

            requestedTier,
            requestedGoal,
            requestedBalanceTransferIntent,
            currentStatus,
            currentStage,
            submittedAt,
            updatedAt
          )
          OUTPUT INSERTED.id, INSERTED.journeyId
          VALUES (
            NEWID(),
            @source,
            @tier,
            @depositAmount,
            @autopayPref,
            @planGoal,
            @balanceTransferIntent,
            @housingStatus,
            @housingPayment,
            @incomeRange,
            @contactPref,
            @status,

            @firstName,
            @middleName,
            @lastName,
            @suffix,
            @displayName,
            @email,
            @stateCode,
            @requestedStartMode,
            @requestedDepositIntent,

            @dob,
            @ssnLast4,
            @addressLine1,
            @addressLine2,
            @city,
            @zip,
            @phoneMobile,
            @phoneHome,

            @requestedTier,
            @requestedGoal,
            @requestedBalanceTransferIntent,
            @currentStatus,
            @currentStage,
            SYSUTCDATETIME(),
            SYSUTCDATETIME()
          )
        `);

      const insertedId = result.recordset?.[0]?.id ?? null;
      const journeyId = result.recordset?.[0]?.journeyId ?? null;

      context.log("Application saved.", {
        applicationId: insertedId,
        journeyId,
        source: payload.source,
        requestedStartMode: payload.requestedStartMode,
        requestedTier: payload.requestedTier
      });

      return {
        status: 200,
        headers,
        jsonBody: {
          message: "Application saved.",
          applicationId: insertedId,
          journeyId
        }
      };
    } catch (err) {
      context.log.error("Application database insert failed.", {
        message: err.message
      });

      return {
        status: 500,
        headers,
        jsonBody: {
          error: "Application could not be saved."
        }
      };
    } finally {
      try {
        await sql.close();
      } catch (_) {
        // Ignore close errors
      }
    }
  }
});