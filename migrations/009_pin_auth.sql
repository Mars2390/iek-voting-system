-- =========================================================
-- PIN-based second factor for login. Closes the account-takeover
-- hole described in migrations/002_login_system.sql: previously any
-- membership number alone was a full login. Now:
--   * An engineer with no pin_hash yet: their next login sets one.
--   * An engineer with a pin_hash: login requires the correct PIN,
--     with a short lockout after repeated wrong attempts.
-- All statements are additive/idempotent — safe to run against the
-- live engineers table.
-- =========================================================

ALTER TABLE engineers ADD COLUMN IF NOT EXISTS pin_hash VARCHAR(200);
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS pin_set_at TIMESTAMP;
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS failed_pin_attempts INTEGER DEFAULT 0;
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMP;
