-- =========================================================
-- Engineer Hub login system — adds self-service profile
-- fields to the existing `engineers` table and a `sessions`
-- table for membership-number-only login.
--
-- Run once against the same Neon database as schema.sql:
--   psql "$DATABASE_URL" -f migrations/002_login_system.sql
-- All statements are additive/idempotent (IF NOT EXISTS) —
-- safe to run against the live 317-row `engineers` table.
-- =========================================================

ALTER TABLE engineers ADD COLUMN IF NOT EXISTS display_name VARCHAR(150);
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS discipline VARCHAR(100);
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS company VARCHAR(150);
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS profile_photo TEXT;
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;

-- No password: a session is created the moment a membership number
-- matches (see api/auth.js). The token itself is a long random value —
-- it's the login *step* that's weak (number-only, no second factor),
-- not the session that follows it.
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    token VARCHAR(64) UNIQUE NOT NULL,
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_engineer_id ON sessions(engineer_id);
