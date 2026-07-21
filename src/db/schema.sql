-- ============================================================
-- Room Match — Asset Plus
-- PostgreSQL schema for the rental matching platform
-- Requires: PostgreSQL 14+
-- ============================================================

-- ---------- ZONES (areas / neighborhoods) ----------
CREATE TABLE IF NOT EXISTS zones (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,                  -- e.g. 'asoke'
  name_th      TEXT NOT NULL,                         -- Thai display name 'อโศก'
  name_en      TEXT,                                  -- English display name
  city         TEXT NOT NULL DEFAULT 'Bangkok',
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zones_active ON zones(is_active, sort_order);

-- ---------- LANDLORDS (property owners) ----------
CREATE TABLE IF NOT EXISTS landlords (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name     TEXT NOT NULL,
  phone         TEXT NOT NULL,
  email         TEXT,
  line_id       TEXT,
  -- billing
  company_name  TEXT,                                  -- optional, for legal/invoicing
  tax_id        TEXT,
  -- meta
  note          TEXT,
  source        TEXT DEFAULT 'website',                -- website / referral / ad
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_landlords_phone  ON landlords(phone);
CREATE INDEX IF NOT EXISTS idx_landlords_active ON landlords(is_active);

-- ---------- ROOMS (listed units) ----------
CREATE TABLE IF NOT EXISTS rooms (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  landlord_id    INTEGER NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  zone_id        INTEGER NOT NULL REFERENCES zones(id),
  title          TEXT NOT NULL,                       -- 'The Line สาทร'
  description    TEXT,
  property_type  TEXT NOT NULL DEFAULT 'condo',       -- condo | townhouse | house | apartment
  bedrooms       INTEGER NOT NULL DEFAULT 1,
  bathrooms      INTEGER NOT NULL DEFAULT 1,
  size_sqm       NUMERIC(8,2) NOT NULL DEFAULT 0,
  monthly_rent   INTEGER NOT NULL DEFAULT 0,
  -- geolocation (for map display + future geocoding)
  lat            NUMERIC(9,6),
  lng            NUMERIC(9,6),
  address        TEXT,
  -- availability
  status         TEXT NOT NULL DEFAULT 'available',   -- available | reserved | matched | inactive
  available_from DATE,                                 -- ISO date
  -- amenities stored as JSONB
  amenities      JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_featured    BOOLEAN NOT NULL DEFAULT FALSE,
  view_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rooms_zone      ON rooms(zone_id);
CREATE INDEX IF NOT EXISTS idx_rooms_status    ON rooms(status);
CREATE INDEX IF NOT EXISTS idx_rooms_featured  ON rooms(is_featured);
CREATE INDEX IF NOT EXISTS idx_rooms_landlord  ON rooms(landlord_id);

-- ---------- ROOM IMAGES ----------
CREATE TABLE IF NOT EXISTS room_images (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  alt_text    TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_room_images_room ON room_images(room_id, sort_order);

-- ---------- TENANTS (renters / leads) ----------
CREATE TABLE IF NOT EXISTS tenants (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name       TEXT NOT NULL,
  phone           TEXT,                                  -- nullable: Google-only users exist before submitting MatchForm
  email           TEXT,
  line_id         TEXT,
  occupation      TEXT,                                -- student / professional / business owner
  monthly_income  INTEGER,                              -- THB
  move_in_date    DATE,
  has_pets        BOOLEAN NOT NULL DEFAULT FALSE,
  smoker          BOOLEAN NOT NULL DEFAULT FALSE,
  note            TEXT,
  source          TEXT DEFAULT 'website',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  -- Google OAuth identity (public users)
  google_sub      TEXT UNIQUE,                          -- Google's stable user id ('sub' claim)
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,       -- from Google's 'email_verified' claim
  picture_url     TEXT,                                  -- from Google's 'picture' claim
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenants_phone  ON tenants(phone);
CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants(is_active);

-- ---------- PREFERENCES (what they're looking for) ----------
CREATE TABLE IF NOT EXISTS preferences (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- polymorphic owner
  landlord_id     INTEGER REFERENCES landlords(id) ON DELETE CASCADE,
  tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('landlord','tenant')),
  -- what they want
  zone_ids        TEXT,                                -- CSV of zone slugs
  property_types  TEXT,                                -- CSV of property types
  min_bedrooms    INTEGER,
  max_bedrooms    INTEGER,
  min_rent        INTEGER,
  max_rent        INTEGER,
  min_size_sqm    INTEGER,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT preferences_owner_check CHECK (
    (role = 'landlord' AND landlord_id IS NOT NULL AND tenant_id IS NULL) OR
    (role = 'tenant'   AND tenant_id   IS NOT NULL AND landlord_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_preferences_role ON preferences(role);

-- ---------- MATCHES (tenant ⇄ room pairings) ----------
CREATE TABLE IF NOT EXISTS matches (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_id       INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'suggested',
                -- suggested | contacted | viewing | contract_signed | rejected
  match_score   NUMERIC(5,2),                          -- 0..100 (optional)
  agent_note    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, room_id)
);
CREATE INDEX IF NOT EXISTS idx_matches_tenant ON matches(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_matches_room   ON matches(room_id, status);

-- ---------- REVIEWS ----------
CREATE TABLE IF NOT EXISTS reviews (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reviewer_name   TEXT NOT NULL,
  reviewer_role   TEXT,                                -- e.g. 'เจ้าของคอนโด ทองหล่อ'
  avatar_emoji    TEXT,
  rating          INTEGER NOT NULL DEFAULT 5 CHECK (rating BETWEEN 1 AND 5),
  body            TEXT NOT NULL,
  is_featured     BOOLEAN NOT NULL DEFAULT FALSE,
  source          TEXT DEFAULT 'website',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reviews_featured ON reviews(is_featured, created_at);

-- ---------- CONTACT MESSAGES (quick contact form) ----------
CREATE TABLE IF NOT EXISTS contact_messages (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  email        TEXT,
  message      TEXT,
  source_page  TEXT,
  status       TEXT NOT NULL DEFAULT 'new',             -- new | contacted | closed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_status ON contact_messages(status, created_at);

-- ---------- ADMINS (staff accounts) ----------
-- Internal only — never exposed via /api/public endpoints.
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,                  -- local login (kept live alongside Azure SSO)
  password_hash TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  -- Azure AD SSO identity
  azure_oid     TEXT UNIQUE,                            -- Entra ID stable user id ('oid' claim)
  display_name  TEXT,                                   -- from Microsoft profile
  email         TEXT,                                   -- from Microsoft profile
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Server-side session store. Token returned to the browser as an HTTP-only cookie.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token       TEXT PRIMARY KEY,                         -- 64-char hex (crypto.randomBytes)
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions(expires_at);

-- Public-user sessions (parallel to admin_sessions). Used by Google sign-in.
CREATE TABLE IF NOT EXISTS user_sessions (
  token       TEXT PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_sessions_expires_idx ON user_sessions(expires_at);

-- ---------- VIEWINGS (วันนัดชมห้อง) ----------
-- Tenant submits a request for a slot; landlord confirms/declines.
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

-- ---------- INQUIRIES (tenant messages to landlord inbox) ----------
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

-- ---------- TENANT LEADS (anonymous "ฉันอยากเช่า" form submissions) ----------
-- Capped to int / text — no FK to tenants since visitor may not be a registered
-- user. Admin surfaces rows in /admin/leads (or reads raw via psql for now).
CREATE TABLE IF NOT EXISTS tenant_leads (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  zone            TEXT,
  monthly_budget  INTEGER,
  property_type   TEXT,
  move_in         TEXT,
  full_name       TEXT NOT NULL,
  phone           TEXT NOT NULL,
  source_page     TEXT,
  status          TEXT NOT NULL DEFAULT 'new',          -- new | contacted | closed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenant_leads_status ON tenant_leads(status, created_at);

-- ── Admin action audit trail (014) ──────────────────────────────────────────
-- Append-only log of every admin write (POST/PATCH/DELETE). Keyed by azure_oid
-- so actions are attributable even if the admin row is later renamed.
CREATE TABLE IF NOT EXISTS admin_action_log (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id      INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  azure_oid     TEXT,
  display_name  TEXT,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  action        TEXT,
  entity_type   TEXT,
  entity_id     TEXT,
  status_code   INTEGER,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_admin  ON admin_action_log(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_entity ON admin_action_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_time   ON admin_action_log(created_at DESC);