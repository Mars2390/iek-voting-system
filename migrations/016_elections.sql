-- =========================================================
-- Engineer Hub Voting: member-run campaigns, official elections,
-- one-vote-per-engineer ballots, and campaign SMS outreach.
--
-- Deliberately NOT reusing the original turnout tracker's tables
-- (`votes`, `candidates`) — those belong to voting.html's check-in
-- desk model (an official marks "this engineer showed up", and clicks
-- +1 on a candidate tally) and still hold the real Aug-2026 election
-- data. This system is different in kind: every ballot is cast by a
-- logged-in engineer against a specific campaign, so it gets its own
-- tables rather than bolting new meaning onto old columns.
--
-- All statements are additive/idempotent — safe to run against the
-- live database.
-- =========================================================

-- Official elections, created by admin. `positions` is a JSON array of
-- position names (e.g. ["President","Honorary Treasurer"]); a campaign
-- inside an election must run for one of them.
--
-- Voting window: opens_at/closes_at are real instants (TIMESTAMPTZ),
-- not the naive wall-clock TIMESTAMP used by `events` — an event time
-- is only ever *displayed*, but a voting window is *compared* against
-- NOW() server-side to decide whether a ballot is accepted, so it has
-- to be unambiguous. closed_at is the admin's manual "close voting
-- now" override; closes_at alone handles the scheduled close.
CREATE TABLE IF NOT EXISTS elections (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    positions JSONB NOT NULL DEFAULT '[]'::jsonb,
    opens_at TIMESTAMPTZ,
    closes_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    nominations_open BOOLEAN NOT NULL DEFAULT TRUE,
    auto_verify BOOLEAN NOT NULL DEFAULT FALSE,
    winners_announced_at TIMESTAMPTZ,
    created_by_email VARCHAR(150),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- A campaign is one engineer running for one position. election_id is
-- NULL for an independent campaign (the engineer sets their own
-- starts_at/ends_at window); inside an official election the window is
-- the election's and starts_at/ends_at are ignored.
CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    election_id INTEGER REFERENCES elections(id) ON DELETE CASCADE,
    creator_id INTEGER NOT NULL REFERENCES engineers(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    position VARCHAR(120) NOT NULL,
    bio TEXT,
    photo_url TEXT,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    status VARCHAR(20) NOT NULL DEFAULT 'active',   -- active | withdrawn
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    verified_by_email VARCHAR(150),
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_campaigns_election ON campaigns(election_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_creator ON campaigns(creator_id);
-- One live campaign per engineer per position per contest. COALESCE
-- folds the NULL election_id of independent campaigns into a single
-- bucket — Postgres treats NULLs as distinct in a plain UNIQUE, which
-- would otherwise let one engineer spin up any number of duplicate
-- independent campaigns for the same position.
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaigns_creator_position
    ON campaigns (creator_id, COALESCE(election_id, 0), LOWER(position))
    WHERE status <> 'withdrawn';

-- One ballot row per (voter, campaign). election_id and position are
-- copied onto the row so the one-vote-per-position rule inside an
-- official election is a plain unique index the database enforces
-- itself under concurrent requests, not a check-then-insert in code.
CREATE TABLE IF NOT EXISTS campaign_votes (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    voter_id INTEGER NOT NULL REFERENCES engineers(id) ON DELETE CASCADE,
    election_id INTEGER REFERENCES elections(id) ON DELETE CASCADE,
    position VARCHAR(120) NOT NULL,
    voter_ip VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_votes_voter_campaign ON campaign_votes (voter_id, campaign_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_votes_voter_election_position
    ON campaign_votes (voter_id, election_id, LOWER(position))
    WHERE election_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_votes_campaign ON campaign_votes(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_votes_election ON campaign_votes(election_id);

-- A campaign SMS send: one batch row (what was sent, to whom, when) plus
-- one recipient row per engineer, which is what powers the "who
-- received / who has voted" tracking and the scheduled-send dispatcher.
-- The message is stored with [Name] placeholders unresolved; the
-- dispatcher personalizes per recipient at send time.
CREATE TABLE IF NOT EXISTS campaign_sms_batches (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES engineers(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    recipient_mode VARCHAR(30) NOT NULL,             -- all | discipline | individual | not_voted
    recipient_filter VARCHAR(150),
    recipients_count INTEGER NOT NULL DEFAULT 0,
    sent_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    invalid_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled', -- scheduled | sending | done | cancelled
    scheduled_for TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_campaign_sms_batches_campaign ON campaign_sms_batches(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_sms_batches_due ON campaign_sms_batches(status, scheduled_for);

CREATE TABLE IF NOT EXISTS campaign_sms_recipients (
    id SERIAL PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES campaign_sms_batches(id) ON DELETE CASCADE,
    engineer_id INTEGER NOT NULL REFERENCES engineers(id) ON DELETE CASCADE,
    phone VARCHAR(20),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',   -- pending | sending | sent | failed | invalid_phone
    provider_message_id VARCHAR(100),
    provider_status VARCHAR(50),
    error VARCHAR(200),
    claimed_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_campaign_sms_recipients_batch ON campaign_sms_recipients(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_campaign_sms_recipients_provider ON campaign_sms_recipients(provider_message_id);
