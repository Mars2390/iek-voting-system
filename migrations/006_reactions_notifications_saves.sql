-- =========================================================
-- Multi-type reactions, notifications, saved posts, post
-- reports, pinned posts, video posts, message typing indicator.
-- Additive/idempotent — safe against the live 317-row `engineers` table.
-- =========================================================

-- Replaces `likes` (kept, unused, for historical/audit purposes) —
-- one row per (post, engineer), reaction_type is swappable so a user
-- can change their reaction without a duplicate row.
CREATE TABLE IF NOT EXISTS reactions (
    id SERIAL PRIMARY KEY,
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    reaction_type VARCHAR(10) NOT NULL DEFAULT 'like',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(post_id, engineer_id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_post_id ON reactions(post_id);

INSERT INTO reactions (post_id, engineer_id, reaction_type, created_at)
SELECT post_id, engineer_id, 'like', created_at FROM likes
ON CONFLICT (post_id, engineer_id) DO NOTHING;

-- target_type/target_id point at whatever the notification is about
-- ('post'/id, 'profile'/engineer id, 'conversation'/id) so the UI can
-- link straight to it without a type-specific fetch first.
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    recipient_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL,
    target_type VARCHAR(20),
    target_id INTEGER,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saved_posts (
    id SERIAL PRIMARY KEY,
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(engineer_id, post_id)
);

-- No moderation queue reviews these yet — this stores the report so
-- the data exists when one gets built, not a working report pipeline.
CREATE TABLE IF NOT EXISTS post_reports (
    id SERIAL PRIMARY KEY,
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    reporter_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_url TEXT;

-- One typer at a time per conversation is all a 1:1 DM needs.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS typing_by INTEGER REFERENCES engineers(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS typing_until TIMESTAMP;
