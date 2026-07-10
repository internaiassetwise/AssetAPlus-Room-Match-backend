-- ============================================================
-- 007_viewings_tenant_line_id.sql — Cache tenant's Line user id on
-- each viewing so the bot can confirm without an extra tenants JOIN.
--
-- Why this column:
--   The bot's confirm-viewing flow needs the tenant's line id to push
--   the confirmation Flex via /api/admin/push. Looking it up via
--   tenants.line_id every time works but means the bot can fail when
--   a tenant row is hard-deleted or anonymised. Caching the value at
--   viewing-creation time keeps the bot path simple + immutable.
--
-- Why nullable + a default '':
--   Existing viewings pre-date this migration — we backfill by joining
--   tenants to populate them. New rows always carry the value because
--   /api/viewings sets it.
-- ============================================================

ALTER TABLE viewings
  ADD COLUMN IF NOT EXISTS tenant_line_user_id TEXT NOT NULL DEFAULT '';

-- Backfill from tenants so admin GET endpoints return real values for
-- rows created before this migration ran.
UPDATE viewings v
   SET tenant_line_user_id = COALESCE(t.line_id, '')
  FROM tenants t
 WHERE t.id = v.tenant_id
   AND (v.tenant_line_user_id = '' OR v.tenant_line_user_id IS NULL);

-- Index so the bot-side GET /api/admin/viewings/by-line/:lineUserId
-- (future) can resolve the active viewing fast.
CREATE INDEX IF NOT EXISTS idx_viewings_tenant_line
  ON viewings(tenant_line_user_id)
  WHERE tenant_line_user_id <> '';