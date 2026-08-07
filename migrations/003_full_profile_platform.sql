-- =========================================================
-- Engineer Hub full platform — profile richness, directory,
-- connections, activity feed, and a jobs board.
--
-- Run once against the same Neon database as schema.sql and
-- migrations/002_login_system.sql:
--   psql "$DATABASE_URL" -f migrations/003_full_profile_platform.sql
-- All statements are additive/idempotent (IF NOT EXISTS) —
-- safe to run against the live 317-row `engineers` table.
-- (display_name, discipline, company, profile_photo, last_login
-- already exist from migration 002 — not repeated here.)
-- =========================================================

ALTER TABLE engineers ADD COLUMN IF NOT EXISTS cover_photo TEXT;
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS title VARCHAR(150);
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS location VARCHAR(150);
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS email VARCHAR(150);
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS github_url TEXT;
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS portfolio_url TEXT;
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS experience_years INTEGER;
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS last_active TIMESTAMP;

CREATE TABLE IF NOT EXISTS work_experience (
    id SERIAL PRIMARY KEY,
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    job_title VARCHAR(150) NOT NULL,
    company_name VARCHAR(150) NOT NULL,
    start_date DATE,
    end_date DATE,
    is_current BOOLEAN DEFAULT FALSE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_work_experience_engineer_id ON work_experience(engineer_id);

CREATE TABLE IF NOT EXISTS education (
    id SERIAL PRIMARY KEY,
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    institution VARCHAR(150) NOT NULL,
    degree VARCHAR(150) NOT NULL,
    field_of_study VARCHAR(150),
    start_year INTEGER,
    end_year INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_education_engineer_id ON education(engineer_id);

CREATE TABLE IF NOT EXISTS skills (
    id SERIAL PRIMARY KEY,
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    skill_name VARCHAR(80) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(engineer_id, skill_name)
);
CREATE INDEX IF NOT EXISTS idx_skills_engineer_id ON skills(engineer_id);

-- Undirected relationship stored as one directed row: requester -> addressee.
-- status: 'pending' | 'accepted' | 'declined'. The UNIQUE constraint below
-- stops a second request in the SAME direction; api/auth.js additionally
-- checks the reverse direction before inserting (A->B pending blocks B->A).
CREATE TABLE IF NOT EXISTS connections (
    id SERIAL PRIMARY KEY,
    requester_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    addressee_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_connections_requester ON connections(requester_id);
CREATE INDEX IF NOT EXISTS idx_connections_addressee ON connections(addressee_id);

CREATE TABLE IF NOT EXISTS activity_feed (
    id SERIAL PRIMARY KEY,
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    action_type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_activity_feed_created_at ON activity_feed(created_at);

-- Lightweight community job board: any logged-in engineer can post one on
-- behalf of their employer (posted_by tracks who, not a company account
-- system — there isn't one). "Apply" is a plain contact/external link, not
-- an in-app application-tracking flow.
CREATE TABLE IF NOT EXISTS jobs (
    id SERIAL PRIMARY KEY,
    posted_by INTEGER REFERENCES engineers(id) ON DELETE SET NULL,
    title VARCHAR(150) NOT NULL,
    company_name VARCHAR(150) NOT NULL,
    location VARCHAR(150),
    job_type VARCHAR(50),
    discipline VARCHAR(100),
    description TEXT NOT NULL,
    apply_url TEXT,
    apply_email VARCHAR(150),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_is_active ON jobs(is_active);
