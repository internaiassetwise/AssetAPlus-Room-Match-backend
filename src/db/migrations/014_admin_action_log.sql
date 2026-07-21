-- 014_admin_action_log.sql — Audit trail for every admin write action.
--
-- Tracks WHO did WHAT, keyed by the admin's Microsoft Entra ID (azure_oid)
-- so actions are attributable even if the admin row is later renamed or
-- the local-login username changes.
--
-- Insert-only (no updates, no deletes) — append-only audit log. Query via
-- /api/v1/admin/audit (future) or directly in psql.

CREATE TABLE IF NOT EXISTS admin_action_log (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id      INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  azure_oid     TEXT,                                   -- Microsoft Entra ID 'oid' claim (nullable for local-login admins)
  display_name  TEXT,                                   -- snapshot at action time — survives admin renames
  method        TEXT NOT NULL,                          -- POST | PATCH | DELETE
  path          TEXT NOT NULL,                          -- route path (e.g. /api/rooms/15/approve)
  action        TEXT,                                   -- short label: room.approve, faq.update, inbox.reply, etc.
  entity_type   TEXT,                                   -- room | faq | viewing | inbox_ticket | landlord ...
  entity_id     TEXT,                                   -- PK of the touched entity (stringified — heterogeneous)
  status_code   INTEGER,                                -- HTTP response status (200, 201, 400, 500...)
  metadata      JSONB DEFAULT '{}',                     -- optional extra context (e.g. room title, reply excerpt)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_action_log_admin   ON admin_action_log(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_entity  ON admin_action_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_time    ON admin_action_log(created_at DESC);
