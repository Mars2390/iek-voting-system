-- =========================================================
-- Email system for the National Engineering Strategy: bulk email
-- from NES@engineerhuub.com via Resend, an engineer<->admin support
-- inbox, and a send history. `engineers.email` and its edit UI
-- already existed before this migration (Contact section on
-- profile.html) — only email_verified is new there.
-- All statements are additive/idempotent — safe to run against the
-- live database.
-- =========================================================

ALTER TABLE engineers ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS support_messages (
    id SERIAL PRIMARY KEY,
    engineer_id INTEGER NOT NULL REFERENCES engineers(id) ON DELETE CASCADE,
    subject VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    admin_reply TEXT,
    replied_by VARCHAR(255),
    replied_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_messages_engineer ON support_messages(engineer_id);
CREATE INDEX IF NOT EXISTS idx_support_messages_status ON support_messages(status);

CREATE TABLE IF NOT EXISTS email_logs (
    id SERIAL PRIMARY KEY,
    sender_id INTEGER REFERENCES engineers(id) ON DELETE SET NULL,
    sender_admin_email VARCHAR(255),
    recipient_ids TEXT,
    recipient_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    subject VARCHAR(255),
    body TEXT,
    template_name VARCHAR(100),
    status VARCHAR(50),
    error_summary TEXT,
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS email_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    is_builtin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed the five requested built-in templates, once — is_builtin rows are
-- identified by name, so this is safe to re-run without duplicating them.
INSERT INTO email_templates (name, subject, body, is_builtin)
SELECT * FROM (VALUES
  ('Welcome to Engineer Hub', 'Welcome to Engineer Hub, {{name}}!',
   E'Hi {{name}},\n\nWelcome to Engineer Hub — the professional network for IEK-affiliated engineers. Your profile is ready, so take a moment to add your discipline, work history, and a photo so other members can find and connect with you.\n\nGlad to have you here.\n\nNational Engineering Strategy Secretariat', TRUE),
  ('IEK Event Invitation', 'You''re invited: {{event_title}}',
   E'Hi {{name}},\n\nYou''re invited to the following IEK event. Full details below.\n\nNational Engineering Strategy Secretariat', TRUE),
  ('National Engineering Strategy Update', 'National Engineering Strategy — Update',
   E'Hi {{name}},\n\nHere''s the latest update from the National Engineering Strategy Secretariat.\n\n[Add your update here]\n\nNational Engineering Strategy Secretariat', TRUE),
  ('CPD Reminder', 'Reminder: Your CPD points', E'Hi {{name}},\n\nThis is a reminder to keep up with your Continuing Professional Development (CPD) points this cycle. Check the IEK Calendar on Engineer Hub for upcoming CPD seminars.\n\nNational Engineering Strategy Secretariat', TRUE),
  ('Job Opportunity', 'A job opportunity that may interest you',
   E'Hi {{name}},\n\nA new job opportunity has been posted that may interest you. Visit the Jobs board on Engineer Hub to see the full listing and apply.\n\nNational Engineering Strategy Secretariat', TRUE)
) AS seed(name, subject, body, is_builtin)
WHERE NOT EXISTS (SELECT 1 FROM email_templates et WHERE et.name = seed.name AND et.is_builtin = TRUE);
