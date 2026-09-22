-- =========================================================
-- SSO bridge to Engineers Hub (Bismarck's Laravel 12 + Sanctum API).
--
-- A member logs in HERE once (IEK number + PIN) and can then use the
-- Laravel-backed features without a second login. This table holds,
-- per engineer, the Engineers Hub account we act as on their behalf:
--
--   origin = 'registered'  We created the account for them on first
--                          use, with a random password only this
--                          backend has ever seen. credential_enc keeps
--                          it so a fresh token can be obtained after
--                          the old one expires.
--   origin = 'linked'      They already had their own Engineers Hub
--                          account and signed in to it once via the
--                          `sso-link` action. We hold only the token;
--                          their password is never stored.
--
-- credential_enc and token_enc are AES-256-GCM sealed with
-- SSO_CRED_KEY, which exists only in Vercel's environment -- a copy of
-- this table on its own is unreadable. Nothing in it is ever the
-- authority for a session on THIS platform: the `sessions` table stays
-- the only gate on every action.
--
-- Additive/idempotent -- safe to run against the live database.
-- =========================================================
CREATE TABLE IF NOT EXISTS sso_identities (
    id SERIAL PRIMARY KEY,
    engineer_id INTEGER NOT NULL REFERENCES engineers(id) ON DELETE CASCADE,
    provider VARCHAR(30) NOT NULL DEFAULT 'engineershub',
    external_user_id VARCHAR(64),
    external_email VARCHAR(190),
    origin VARCHAR(20) NOT NULL,                     -- registered | linked
    credential_enc TEXT,                             -- registered accounts only
    token_enc TEXT,
    token_expires_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'linked',    -- linked | broken | unlinked
    last_error VARCHAR(300),
    linked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMPTZ
);
-- One Engineers Hub account per engineer, and one engineer per
-- Engineers Hub account -- the second index is what stops two members
-- ever sharing a his-side identity.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sso_identities_engineer
    ON sso_identities (provider, engineer_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sso_identities_external
    ON sso_identities (provider, external_user_id)
    WHERE external_user_id IS NOT NULL;
