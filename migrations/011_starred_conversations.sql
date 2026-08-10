-- Starring is per-viewer, not shared between the two participants in a
-- conversation, so it's a join table keyed on (engineer, conversation)
-- rather than a column on `conversations` itself.
CREATE TABLE IF NOT EXISTS starred_conversations (
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (engineer_id, conversation_id)
);
