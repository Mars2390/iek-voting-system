-- =========================================================
-- Profile view tracking, follow system (separate from connections),
-- multi-photo posts, message editing. Additive/idempotent — safe
-- against the live 317-row `engineers` table.
-- =========================================================

-- One row per (viewer, viewed) pair — re-viewing bumps created_at
-- rather than growing unboundedly, so "who viewed your profile" shows
-- each person once, at their most recent visit (matches LinkedIn).
CREATE TABLE IF NOT EXISTS profile_views (
    id SERIAL PRIMARY KEY,
    viewer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    viewed_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(viewer_id, viewed_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_views_viewed ON profile_views(viewed_id, created_at DESC);

-- Deliberately separate from `connections` — a follow is one-way and
-- needs no acceptance, unlike a connection request.
CREATE TABLE IF NOT EXISTS follows (
    id SERIAL PRIMARY KEY,
    follower_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    followee_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

-- Multi-photo posts. `image_url` (singular) stays as-is for every
-- existing post; new posts with more than one photo populate this
-- array instead and the singular column is left null for them.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_urls TEXT[];

ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
