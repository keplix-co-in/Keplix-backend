-- Adds notification kind + tap payload.
--
-- Both apps currently pick a notification's icon by substring-matching its
-- title, so most notifications render a generic bell and any copy reword
-- silently changes the icon. createNotification already accepted a `metadata`
-- argument and then threw it away, so there was nowhere to persist the kind.
--
-- Both columns are nullable: every existing row predates them.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "type" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "data" JSONB;

-- The list screens read newest-first for a single user.
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx"
  ON "Notification" ("userId", "createdAt");
