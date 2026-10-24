CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         citext NOT NULL UNIQUE,
    password_hash text NOT NULL,
    display_name  text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Opaque bearer tokens, stored as SHA-256 hashes. Refresh tokens rotate on use; a
-- reused refresh token revokes its whole family (theft detection).
CREATE TABLE auth_tokens (
    token_hash  bytea PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('access', 'refresh')),
    family_id   uuid NOT NULL,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    revoked_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    user_agent  text
);
CREATE INDEX auth_tokens_family ON auth_tokens (family_id);
CREATE INDEX auth_tokens_user ON auth_tokens (user_id);
CREATE INDEX auth_tokens_expires ON auth_tokens (expires_at);

CREATE TABLE clips (
    id               text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9]{10}$'),
    owner_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title            text NOT NULL,
    game_name        text,
    status           text NOT NULL CHECK (status IN ('UPLOADING', 'PROCESSING', 'READY', 'FAILED')),
    visibility       text NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
    allow_download   boolean NOT NULL DEFAULT true,
    duration_ms      integer NOT NULL,
    width            integer NOT NULL,
    height           integer NOT NULL,
    size_bytes       bigint NOT NULL,
    sha256           text NOT NULL,
    original_key     text NOT NULL,
    upload_id        text,
    part_size        integer NOT NULL,
    part_count       integer NOT NULL,
    error            text,
    recorded_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    ready_at         timestamptz
);
CREATE INDEX clips_owner_created ON clips (owner_id, created_at DESC, id DESC);
-- Duplicate prevention: one live clip per owner and file content.
CREATE UNIQUE INDEX clips_owner_sha ON clips (owner_id, sha256) WHERE status <> 'FAILED';

CREATE TABLE renditions (
    clip_id      text NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
    label        text NOT NULL,
    object_key   text NOT NULL,
    content_type text NOT NULL,
    width        integer NOT NULL,
    height       integer NOT NULL,
    size_bytes   bigint NOT NULL,
    etag         text,
    PRIMARY KEY (clip_id, label)
);

-- Background work, claimed with FOR UPDATE SKIP LOCKED (no Redis needed).
CREATE TABLE jobs (
    id           bigserial PRIMARY KEY,
    kind         text NOT NULL,
    payload      jsonb NOT NULL,
    status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts     integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 3,
    run_after    timestamptz NOT NULL DEFAULT now(),
    locked_at    timestamptz,
    locked_by    text,
    last_error   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz
);
CREATE INDEX jobs_pending ON jobs (run_after, id) WHERE status = 'queued';
