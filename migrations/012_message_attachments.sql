-- Messages can now carry an image, a generic file, or a voice note
-- instead of (or alongside) text. content becomes nullable — a
-- photo/voice/file message with no caption has nothing to put there.
ALTER TABLE messages ALTER COLUMN content DROP NOT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_type VARCHAR(10); -- 'image' | 'file' | 'voice'
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name TEXT; -- original filename, for file attachments
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_size INTEGER; -- bytes
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_duration REAL; -- seconds, for voice notes
