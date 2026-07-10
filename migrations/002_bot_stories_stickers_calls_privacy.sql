CREATE TABLE IF NOT EXISTS nyx_bots (
  id BIGSERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  webhook_url TEXT,
  inline_mode BOOLEAN NOT NULL DEFAULT FALSE,
  mini_app_url TEXT,
  payments_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nyx_bot_commands (
  bot_id BIGINT NOT NULL REFERENCES nyx_bots(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  description TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY(bot_id, command, scope)
);

CREATE TABLE IF NOT EXISTS nyx_stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_type TEXT NOT NULL DEFAULT 'user',
  author_id BIGINT NOT NULL,
  media JSONB NOT NULL,
  caption TEXT,
  privacy JSONB NOT NULL DEFAULT '{"type":"contacts"}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nyx_story_views (
  story_id UUID NOT NULL REFERENCES nyx_stories(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(story_id, user_id)
);

CREATE TABLE IF NOT EXISTS nyx_sticker_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  short_name TEXT UNIQUE NOT NULL,
  pack_type TEXT NOT NULL DEFAULT 'regular',
  published BOOLEAN NOT NULL DEFAULT FALSE,
  moderated BOOLEAN NOT NULL DEFAULT FALSE,
  price_nyx BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nyx_sticker_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id UUID NOT NULL REFERENCES nyx_sticker_packs(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  asset JSONB NOT NULL,
  animated BOOLEAN NOT NULL DEFAULT FALSE,
  video BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nyx_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_type TEXT NOT NULL,
  dialog_id UUID,
  initiator_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  turn_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nyx_secret_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id BIGINT NOT NULL,
  user_b_id BIGINT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  verification_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  auto_delete_seconds INTEGER,
  screenshot_protection BOOLEAN NOT NULL DEFAULT TRUE,
  cloud_sync_disabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
