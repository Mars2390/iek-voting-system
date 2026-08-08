-- =========================================================
-- Engineer Hub feed (posts/comments/likes) + jobs board extras.
-- Additive/idempotent — safe against the live 317-row `engineers` table.
-- =========================================================

-- A repost is just a new post row with reposted_from_id set — it shows
-- up in the feed like any other post (no separate shares table/join
-- needed), which is also literally what "repost appears as a new post"
-- means. content is nullable because a bare repost with no added
-- commentary has nothing of its own to say.
CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY,
    author_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    content TEXT,
    image_url TEXT,
    reposted_from_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_posts_author_id ON posts(author_id);

CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY,
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    author_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);

CREATE TABLE IF NOT EXISTS likes (
    id SERIAL PRIMARY KEY,
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(post_id, engineer_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_post_id ON likes(post_id);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_min INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_max INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
