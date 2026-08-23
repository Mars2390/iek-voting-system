-- =========================================================
-- Consent tracking for the National Engineering Strategy privacy/
-- consent requirement. Two separate flags because they're legally
-- different things: consent_data_at is the required consent to be
-- processed at all (given once, at account setup, alongside the PIN —
-- see the `login` action's needsPinSetup branch) and consent_marketing
-- is the optional, freely-revocable opt-in to hear about jobs/
-- training/mentorship, editable anytime from Settings.
-- All statements are additive/idempotent — safe to run against the
-- live engineers table.
-- =========================================================

ALTER TABLE engineers ADD COLUMN IF NOT EXISTS consent_data_at TIMESTAMP;
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS consent_marketing BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE engineers ADD COLUMN IF NOT EXISTS consent_marketing_at TIMESTAMP;
