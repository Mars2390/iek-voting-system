-- =========================================================
-- Engineer Hub messaging + "open to work" toggle.
--
-- Run once against the same Neon database as the prior migrations:
--   psql "$DATABASE_URL" -f migrations/004_messaging.sql
-- Additive/idempotent — safe against the live 317-row `engineers` table.
--
-- Messaging is restricted to accepted connections (see api/auth.js) —
-- not enforced at the DB level here, same pattern as `connections`
-- itself, which relies on the API layer for the business rule.
-- =========================================================

ALTER TABLE engineers ADD COLUMN IF NOT EXISTS open_to_work BOOLEAN DEFAULT FALSE;

-- One row per pair, direction-independent (least/greatest, same
-- normalization trick as `connections`'s implicit pairing).
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    participant1_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    participant2_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    last_message_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(participant1_id, participant2_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_p1 ON conversations(participant1_id);
CREATE INDEX IF NOT EXISTS idx_conversations_p2 ON conversations(participant2_id);

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
