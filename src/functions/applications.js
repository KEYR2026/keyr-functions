const { app } = require('@azure/functions');
const sql = require('mssql');

function toNullableString(value) {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    return str === '' ? null : str;
}

function toNullableInt(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNullableDate(value) {
    if (!value) return null;
    const d = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}

app.http('applications', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const conn = process.env.KEYR_DB_CONNECTION;

            if (!conn) {
                return {
                    status: 500,
                    jsonBody: {
                        error: 'Database connection string not found in environment variables.'
                    }
                };
            }

            if (request.method === 'GET') {
                return {
                    status: 200,
                    jsonBody: {
                        message: 'Applications function is live ✅',
                        mode: 'Use POST with JSON body to save an application.'
                    }
                };
            }

            const data = await request.json();

            if (!data.source || !data.tier) {
                return {
                    status: 400,
                    jsonBody: {
                        error: 'Missing required fields.',
                        required: ['source', 'tier']
                    }
                };
            }

            const pool = await sql.connect(conn);

            const result = await pool.request()
                // existing/base fields
                .input('source', sql.VarChar(50), toNullableString(data.source))
                .input('tier', sql.VarChar(50), toNullableString(data.tier))
                .input('depositAmount', sql.Int, toNullableInt(data.depositAmount))
                .input('autopayPref', sql.VarChar(20), toNullableString(data.autopayPref))
                .input('planGoal', sql.VarChar(255), toNullableString(data.planGoal))
                .input('balanceTransferIntent', sql.VarChar(255), toNullableString(data.balanceTransferIntent))
                .input('housingStatus', sql.VarChar(50), toNullableString(data.housingStatus))
                .input('housingPayment', sql.Int, toNullableInt(data.housingPayment))
                .input('incomeRange', sql.VarChar(50), toNullableString(data.incomeRange))
                .input('contactPref', sql.VarChar(50), toNullableString(data.contactPref))

                // identity / master fields
                .input('firstName', sql.VarChar(100), toNullableString(data.firstName))
                .input('middleName', sql.VarChar(100), toNullableString(data.middleName))
                .input('lastName', sql.VarChar(100), toNullableString(data.lastName))
                .input('suffix', sql.VarChar(20), toNullableString(data.suffix))
                .input('displayName', sql.VarChar(255), toNullableString(data.displayName))
                .input('email', sql.VarChar(255), toNullableString(data.email))
                .input('stateCode', sql.VarChar(10), toNullableString(data.stateCode))
                .input('requestedStartMode', sql.VarChar(50), toNullableString(data.requestedStartMode))
                .input('requestedDepositIntent', sql.VarChar(100), toNullableString(data.requestedDepositIntent))

                // newly added combined fields
                .input('dob', sql.Date, toNullableDate(data.dob))
                .input('ssnLast4', sql.VarChar(4), toNullableString(data.ssnLast4))
                .input('addressLine1', sql.VarChar(255), toNullableString(data.addressLine1))
                .input('addressLine2', sql.VarChar(255), toNullableString(data.addressLine2))
                .input('city', sql.VarChar(100), toNullableString(data.city))
                .input('zip', sql.VarChar(10), toNullableString(data.zip))
                .input('phoneMobile', sql.VarChar(50), toNullableString(data.phoneMobile))
                .input('phoneHome', sql.VarChar(50), toNullableString(data.phoneHome))

                // requested / journey fields
                .input('requestedTier', sql.VarChar(50), toNullableString(data.requestedTier || data.tier))
                .input('requestedGoal', sql.VarChar(255), toNullableString(data.requestedGoal || data.planGoal))
                .input(
                    'requestedBalanceTransferIntent',
                    sql.VarChar(255),
                    toNullableString(data.requestedBalanceTransferIntent || data.balanceTransferIntent)
                )
                .input('currentStatus', sql.VarChar(50), 'submitted')
                .input('currentStage', sql.VarChar(50), 'apply_submitted')
                .input('status', sql.VarChar(50), 'submitted')

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

            return {
                status: 200,
                jsonBody: {
                    message: 'Application saved ✅',
                    applicationId: insertedId,
                    journeyId
                }
            };
        } catch (err) {
            context.log.error('SQL insert failed:', err);

            return {
                status: 500,
                jsonBody: {
                    error: 'Failed to save application',
                    details: err.message
                }
            };
        } finally {
            try {
                await sql.close();
            } catch (_) {
                // ignore close errors
            }
        }
    }
});