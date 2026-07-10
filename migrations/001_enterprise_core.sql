-- Nyx Enterprise PostgreSQL core migration.
-- Run: npm run migrate:pg

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS migration_meta (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nyx_users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  nickname TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  sign_public_key TEXT NOT NULL,
  box_public_key TEXT NOT NULL,
  avatar_path TEXT,
  bio TEXT,
  premium_emoji TEXT,
  is_premium BOOLEAN NOT NULL DEFAULT FALSE,
  nyx_balance BIGINT NOT NULL DEFAULT 1000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nyx_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id BIGINT NOT NULL REFERENCES nyx_users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  push_token TEXT,
  app_version TEXT,
  ip_hash TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nyx_dialogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dialog_type TEXT NOT NULL CHECK (dialog_type IN ('direct','group','supergroup','channel','bot','secret')),
  title TEXT,
  owner_id BIGINT REFERENCES nyx_users(id),
  visibility TEXT NOT NULL DEFAULT 'private',
  protected_content BOOLEAN NOT NULL DEFAULT FALSE,
  auto_delete_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nyx_dialog_members (
  dialog_id UUID NOT NULL REFERENCES nyx_dialogs(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES nyx_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  rights JSONB NOT NULL DEFAULT '{}'::jsonb,
  muted_until TIMESTAMPTZ,
  banned_until TIMESTAMPTZ,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(dialog_id, user_id)
);

CREATE TABLE IF NOT EXISTS nyx_messages (
  id BIGSERIAL PRIMARY KEY,
  dialog_id UUID NOT NULL REFERENCES nyx_dialogs(id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL REFERENCES nyx_users(id),
  message_type TEXT NOT NULL DEFAULT 'text',
  ciphertext TEXT,
  nonce TEXT,
  plain_text TEXT,
  media JSONB NOT NULL DEFAULT '[]'::jsonb,
  entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  reply_to_message_id BIGINT REFERENCES nyx_messages(id),
  topic_id BIGINT,
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nyx_messages_dialog_created ON nyx_messages(dialog_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nyx_messages_search ON nyx_messages USING GIN (to_tsvector('simple', coalesce(plain_text, '')));

CREATE TABLE IF NOT EXISTS nyx_message_reactions (
  message_id BIGINT NOT NULL REFERENCES nyx_messages(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES nyx_users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  is_premium BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS nyx_media_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id BIGINT NOT NULL REFERENCES nyx_users(id),
  storage_provider TEXT NOT NULL DEFAULT 's3',
  bucket TEXT,
  object_key TEXT NOT NULL,
  cdn_url TEXT,
  original_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  preview JSONB NOT NULL DEFAULT '{}'::jsonb,
  encryption JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nyx_media_owner ON nyx_media_objects(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS nyx_bot_updates (
  id BIGSERIAL PRIMARY KEY,
  bot_id BIGINT NOT NULL,
  update_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  delivered BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nyx_bot_updates_pending ON nyx_bot_updates(bot_id, delivered, id);

CREATE TABLE IF NOT EXISTS nyx_audit_log (
  id BIGSERIAL PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  actor_id BIGINT REFERENCES nyx_users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nyx_audit_scope ON nyx_audit_log(scope_type, scope_id, created_at DESC);

CREATE TABLE IF NOT EXISTS nyx_notification_queue (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES nyx_users(id),
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_id TEXT NOT NULL DEFAULT 'global',
  title TEXT,
  body TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  silent BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_nyx_notification_pending ON nyx_notification_queue(status, created_at);
