/*
  Survey idempotency migration for queue-backed intake.
  Safe to run once; if re-run, it will only add missing objects.
  This column remains nullable for legacy rows already stored before the queue-based rollout.
*/

IF OBJECT_ID(N'dbo.SurveySubmissions', N'U') IS NULL
BEGIN
  RAISERROR('dbo.SurveySubmissions does not exist. Migration halted.', 16, 1);
  RETURN;
END;

IF COL_LENGTH(N'dbo.SurveySubmissions', N'client_submission_id') IS NULL
BEGIN
  ALTER TABLE dbo.SurveySubmissions
    ADD client_submission_id UNIQUEIDENTIFIER NULL;
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = N'IX_SurveySubmissions_ClientSubmissionId'
    AND object_id = OBJECT_ID(N'dbo.SurveySubmissions')
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX IX_SurveySubmissions_ClientSubmissionId
    ON dbo.SurveySubmissions(client_submission_id)
    WHERE client_submission_id IS NOT NULL;
END;

/*
  Verification queries (read-only):

  SELECT TOP 25 *
  FROM dbo.SurveySubmissions
  WHERE client_submission_id IS NOT NULL;

  SELECT COUNT(*) AS duplicate_client_submission_count
  FROM (
    SELECT client_submission_id
    FROM dbo.SurveySubmissions
    WHERE client_submission_id IS NOT NULL
    GROUP BY client_submission_id
    HAVING COUNT(*) > 1
  ) d;
*/
