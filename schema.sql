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
--
-- If you already have a live database from a previous version of this
-- app, DO NOT re-run this file against it — run `node setup.js` instead,
-- which migrates existing data safely (see setup.js for the migration
-- steps: contact_status value remap, legacy remarks backfill, etc.)
-- rather than assuming a blank database.
-- =========================================================

CREATE TABLE IF NOT EXISTS engineers (
    id SERIAL PRIMARY KEY,
    iek_number VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    voted BOOLEAN DEFAULT FALSE,
    -- Legacy single-note field from early imports. No longer written to by
    -- the app — new notes go in the `remarks` table below (author +
    -- timestamp per entry). Kept here, read-only, so old imported notes
    -- (e.g. campaign contact details folded in during CSV import) aren't lost.
    remarks TEXT,
    -- Canvassing/GOTV call status. One of: 'pending' (default), 'confirmed',
    -- 'no_answer', 'busy_declined', 'follow_up', 'not_reachable'.
    -- Independent of `voted` — this tracks the calling campaign, not
    -- whether someone has actually cast a vote.
    contact_status VARCHAR(20) DEFAULT 'pending',
    last_contacted_at TIMESTAMP,
    call_count INTEGER DEFAULT 0,
    -- Maintained automatically whenever contact_status changes
    -- (true iff contact_status = 'confirmed'). Not independently settable.
    confirmed_vote BOOLEAN DEFAULT FALSE,
    -- NOTE: present for compatibility, but NOT the source of truth for
    -- "who needs follow-up" — one of the flag criteria is time-based ("no
    -- remark in the last 2 days"), which goes stale the moment time passes
    -- without a write. GET /api/engineers and /api/urgent compute the real
    -- flag live in SQL on every request instead of trusting this column.
    needs_followup BOOLEAN DEFAULT FALSE,
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

-- Candidates being voted FOR (e.g. "Eng. Stariko Nyamori — Honorary Treasurer").
-- This is separate from `engineers` on purpose: `engineers` tracks turnout
-- (did this registered member show up and vote), while `candidates` tracks
-- tallies per office. A candidate is not required to also be a row in
-- `engineers` (and vice versa) — the two lists are independent.
CREATE TABLE IF NOT EXISTS candidates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    position VARCHAR(100) NOT NULL,
    votes INTEGER DEFAULT 0,
    photo_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_candidates_position ON candidates(position);

-- Every logged call attempt. This is the single source of truth for the
-- calling campaign — both the quick per-row status dropdown and the full
-- "Log Call" form write here, which is what keeps engineers.contact_status/
-- call_count/last_contacted_at in sync (see api/contact-calls.js).
CREATE TABLE IF NOT EXISTS contact_calls (
    id SERIAL PRIMARY KEY,
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    caller_name VARCHAR(100),
    call_status VARCHAR(50),
    notes TEXT,
    called_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Authored remarks (who wrote it, when, what it says) — one row per note,
-- replacing free-text overwrites of a single field. engineers.remarks
-- (above) still holds whatever was imported before this table existed.
CREATE TABLE IF NOT EXISTS remarks (
    id SERIAL PRIMARY KEY,
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    author VARCHAR(100),
    remark TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contact_calls_engineer_id ON contact_calls(engineer_id);
CREATE INDEX IF NOT EXISTS idx_contact_calls_called_at ON contact_calls(called_at);
CREATE INDEX IF NOT EXISTS idx_remarks_engineer_id ON remarks(engineer_id);
CREATE INDEX IF NOT EXISTS idx_remarks_created_at ON remarks(created_at);
