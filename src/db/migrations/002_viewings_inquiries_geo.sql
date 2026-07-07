-- ============================================================
-- 002_viewings_inquiries_geo.sql — Calendar + inquiries + room geolocation.
--
-- Non-destructive: only ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
-- Safe to run on every container start.
-- ============================================================

-- ── rooms: lat/lng/address for map display + future geocoding ──
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS lat     NUMERIC(9,6);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS lng     NUMERIC(9,6);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS address TEXT;

-- ── viewings: room viewing appointments (วันนัดชมห้อง) ──
CREATE TABLE IF NOT EXISTS viewings (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id       INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_for TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested','confirmed','declined','completed','cancelled')),
  note          TEXT,
  landlord_note TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_viewings_room   ON viewings(room_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_viewings_tenant ON viewings(tenant_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_viewings_status ON viewings(status, scheduled_for);

-- ── inquiries: tenant messages to landlord (room inbox) ──
CREATE TABLE IF NOT EXISTS inquiries (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','replied','closed')),
  reply       TEXT,
  replied_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inquiries_room   ON inquiries(room_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_inquiries_tenant ON inquiries(tenant_id, created_at);