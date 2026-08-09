-- =========================================================
-- Admin panel sessions. Deliberately separate from `sessions`
-- (engineer logins) — admin auth (allowlisted email + PIN) is a
-- different, much narrower trust model and shouldn't share a table
-- or code path with the public membership-number login.
-- =========================================================
CREATE TABLE IF NOT EXISTS admin_sessions (
    id SERIAL PRIMARY KEY,
    token VARCHAR(64) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token);
