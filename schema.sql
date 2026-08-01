-- =========================================================
-- IEK Online Voting System — Neon PostgreSQL schema
--
-- Run this ONCE against your Neon database before using the
-- app or calling POST /api/seed:
--
--   psql "$DATABASE_URL" -f schema.sql
--
-- ...or paste it into the Neon Console SQL Editor
-- (https://console.neon.tech -> your project -> SQL Editor).
-- =========================================================

CREATE TABLE IF NOT EXISTS engineers (
    id SERIAL PRIMARY KEY,
    iek_number VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    voted BOOLEAN DEFAULT FALSE,
    remarks TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- NOTE: ON DELETE CASCADE added (not in the original spec) so that
-- removing an engineer doesn't fail with a foreign key violation.
CREATE TABLE IF NOT EXISTS votes (
    id SERIAL PRIMARY KEY,
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    voter_ip VARCHAR(50)
);

-- NOTE: ON DELETE SET NULL added so the audit trail entry for a
-- DELETE action survives even after the engineer row is gone —
-- engineer_id will read NULL for that historical row, but the
-- action/timestamp/IP are preserved.
CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    action VARCHAR(50),
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE SET NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_ip VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_votes_engineer_id ON votes(engineer_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_engineer_id ON audit_log(engineer_id);
