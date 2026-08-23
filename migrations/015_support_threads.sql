-- =========================================================
-- Upgrades Support from one flat message+reply row into a real
-- Gmail-style conversation thread, and makes it able to receive
-- inbound replies via Resend's Inbound webhook (email.received),
-- not just replies typed into the Support page.
--
-- Why a new table pair instead of altering support_messages: a thread
-- can now hold an arbitrary number of back-and-forth messages, some
-- from the app and some arriving as real inbound email — a single
-- `admin_reply TEXT` column can't represent that. Existing
-- support_messages rows are migrated in, not dropped (this repo's own
-- convention is additive/idempotent migrations — see every prior
-- migrations/*.sql file).
-- =========================================================

CREATE TABLE IF NOT EXISTS support_threads (
    id SERIAL PRIMARY KEY,
    -- Nullable: an inbound reply that doesn't match any known thread
    -- AND doesn't match an engineer's email on file still needs
    -- somewhere to land so an admin can see it, rather than being
    -- silently dropped.
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    sender_name VARCHAR(255),
    sender_email VARCHAR(255),
    subject VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_threads_engineer ON support_threads(engineer_id);
CREATE INDEX IF NOT EXISTS idx_support_threads_status ON support_threads(status);

CREATE TABLE IF NOT EXISTS support_thread_messages (
    id SERIAL PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
    sender_type VARCHAR(20) NOT NULL, -- 'engineer' | 'admin'
    sender_name VARCHAR(255),
    sender_email VARCHAR(255),
    body TEXT NOT NULL,
    source VARCHAR(20) NOT NULL DEFAULT 'app', -- 'app' | 'inbound_email'
    -- The Message-ID *we* set on an outbound message, so a reply's
    -- In-Reply-To/References headers can be matched back to a thread
    -- without relying on fuzzy subject-line parsing.
    outbound_message_id VARCHAR(500),
    -- The RFC 5322 Message-ID header of an INBOUND message (distinct
    -- from resend_email_id below, which is Resend's own internal UUID
    -- for the email, not the header) — needed to set In-Reply-To
    -- correctly on our reply so the recipient's client threads it.
    email_message_id VARCHAR(500),
    -- Resend's own id, for the message we sent OR the email we received.
    -- resend_email_id has a unique constraint so a webhook retry (Resend
    -- explicitly documents these can happen) can't insert the same
    -- inbound reply twice.
    resend_email_id VARCHAR(100) UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_stm_thread ON support_thread_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_stm_outbound_msgid ON support_thread_messages(outbound_message_id);

-- Migrate existing support_messages rows in, one thread + up to two
-- messages each. ON CONFLICT guards let this file re-run safely.
INSERT INTO support_threads (id, engineer_id, subject, status, created_at, last_message_at)
SELECT id, engineer_id, subject, status, created_at, COALESCE(replied_at, updated_at, created_at)
FROM support_messages
ON CONFLICT (id) DO NOTHING;
-- Keeps support_threads' own SERIAL sequence consistent with the ids
-- just inserted explicitly above (INSERT ... SELECT id bypasses
-- nextval(), so the sequence wouldn't otherwise know about them).
SELECT setval('support_threads_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM support_threads), 1));

INSERT INTO support_thread_messages (thread_id, sender_type, body, source, created_at)
SELECT id, 'engineer', message, 'app', created_at FROM support_messages
WHERE NOT EXISTS (SELECT 1 FROM support_thread_messages m WHERE m.thread_id = support_messages.id AND m.sender_type = 'engineer');

INSERT INTO support_thread_messages (thread_id, sender_type, sender_email, body, source, created_at)
SELECT id, 'admin', replied_by, admin_reply, 'app', COALESCE(replied_at, updated_at, created_at)
FROM support_messages
WHERE admin_reply IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM support_thread_messages m WHERE m.thread_id = support_messages.id AND m.sender_type = 'admin');
