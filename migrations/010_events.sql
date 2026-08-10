-- IEK Calendar: official events (AGMs, seminars, CPD sessions) posted by
-- admin, visible to every member, with a broadcast notification on create.
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    location VARCHAR(200),
    event_at TIMESTAMP NOT NULL,
    image_url TEXT,
    register_url TEXT,
    document_url TEXT,
    created_by_email VARCHAR(150),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_event_at ON events(event_at);
