// src/db.js
//
// SQLite через better-sqlite3 — синхронный, быстрый, без внешней СУБД,
// идеально для старта на одном сервере/VPS. Файл базы хранится в volume
// (см. docker-compose.yml), чтобы данные переживали передеплой контейнера.
//
// Для реального роста нагрузки (много инстансов сервера, горизонтальное
// масштабирование) — миграция на Postgres прямая: схема ниже написана
// на почти-стандартном SQL, замена драйвера (better-sqlite3 -> pg) и
// синтаксиса AUTOINCREMENT/TEXT на SERIAL/аналоги — единственное, что
// потребуется поменять.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'nyx.db');

require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -64000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    sign_public_key TEXT NOT NULL,   -- Ed25519, base64 — для проверки подписи при восстановлении
    box_public_key TEXT NOT NULL,    -- X25519, base64 — публичный ключ для E2E-шифрования сообщений
    referral_code TEXT,
    avatar_path TEXT,                -- относительный путь к файлу аватара (см. /avatars static route)
    bio TEXT,                        -- краткий статус профиля
    premium_emoji TEXT,              -- эмодзи рядом с ником для premium-пользователей
    is_premium INTEGER NOT NULL DEFAULT 0,
    nyx_balance INTEGER NOT NULL DEFAULT 1000, -- СЕРВЕРНЫЙ баланс — только для маркетплейса юзернеймов
                                                -- (НЕ путать с локальным клиентским useWalletStore —
                                                -- тот отдельный, для демонстрации экономики рекламы/стейкинга;
                                                -- этот баланс — единственный источник правды для сделок
                                                -- МЕЖДУ реальными пользователями, поэтому живёт на сервере)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recovery_challenges (
    username TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a_id INTEGER NOT NULL REFERENCES users(id),
    user_b_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_a_id, user_b_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    sender_id INTEGER NOT NULL REFERENCES users(id),
    -- Сервер хранит ТОЛЬКО шифротекст + nonce. Расшифровать может лишь
    -- получатель своим box-приватным ключом (никогда не покидающим устройство).
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'text', -- 'text' | 'coin' | 'sticker' (тип не шифруется, чтобы клиент мог отрисовать иконку до расшифровки)
    self_destruct_seconds INTEGER,
    delivered_at TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Каналы — открытое вещание (НЕ E2E, в отличие от личных сообщений выше).
  -- Это сознательное решение: настоящее сквозное шифрование для broadcast
  -- одному сообщению на N произвольных подписчиков требует протокола вроде
  -- Signal Sender Keys/MLS — отдельная большая система. Обычные broadcast-каналы не являются E2E; E2E применяется к личным/секретным чатам.
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS channel_subscriptions (
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channel_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    sender_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Маркетплейс юзернеймов: продавец выставляет СВОБОДНЫЙ (никем не занятый
  -- как активный username) "красивый" юзернейм на продажу; покупатель платит
  -- NYX и получает listed_username как свой новый активный username.
  -- Продавец не теряет свою личность — он изначально не был залогинен под
  -- listed_username, а просто "застолбил" желаемую строку под продажу.
  CREATE TABLE IF NOT EXISTS username_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL REFERENCES users(id),
    listed_username TEXT NOT NULL,
    price INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'sold' | 'cancelled'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    is_premium INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(message_id, user_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS business_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    working_hours_enabled INTEGER NOT NULL DEFAULT 0,
    working_hours_from TEXT,
    working_hours_to TEXT,
    working_hours_timezone TEXT DEFAULT 'Europe/Moscow',
    working_hours_weekdays TEXT DEFAULT '1,2,3,4,5',
    auto_reply_enabled INTEGER NOT NULL DEFAULT 0,
    auto_reply_message TEXT,
    auto_reply_delay_seconds INTEGER DEFAULT 5,
    auto_reply_once INTEGER DEFAULT 1,
    business_name TEXT,
    business_category TEXT,
    business_description TEXT,
    business_email TEXT,
    business_website TEXT,
    business_phone TEXT
  );

  CREATE TABLE IF NOT EXISTS quick_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    shortcut TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    last_active TEXT NOT NULL DEFAULT (datetime('now')),
    is_current INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sticker_packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    is_animated INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sticker_pack_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_id INTEGER NOT NULL REFERENCES sticker_packs(id),
    sticker_index INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    name TEXT,
    lottie_url TEXT,
    UNIQUE(pack_id, sticker_index)
  );

  CREATE TABLE IF NOT EXISTS premium_emoji_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    premium_emoji_id TEXT NOT NULL,
    purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, premium_emoji_id)
  );

  -- ── Группы (многосторонние чаты) ──
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    is_public INTEGER NOT NULL DEFAULT 0,
    username TEXT,
    photo_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(username)
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'member',  -- 'member' | 'admin' | 'owner'
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id),
    sender_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  );

  -- ── Дополнительные таблицы для каналов (админы, инвайты, настройки) ──
  CREATE TABLE IF NOT EXISTS channel_admins (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'admin',  -- 'admin' | 'owner'
    promoted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channel_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  );
`);

// Миграция для БД, созданных до появления профиля/маркетплейса: пытаемся
// добавить недостающие колонки, игнорируя ошибку "duplicate column" если
// они уже есть (better-sqlite3 не умеет ADD COLUMN IF NOT EXISTS напрямую).
const migrationColumns = [
  "ALTER TABLE users ADD COLUMN avatar_path TEXT",
  "ALTER TABLE users ADD COLUMN bio TEXT",
  "ALTER TABLE users ADD COLUMN premium_emoji TEXT",
  "ALTER TABLE users ADD COLUMN is_premium INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN nyx_balance INTEGER NOT NULL DEFAULT 1000",
  "ALTER TABLE messages ADD COLUMN attachment_path TEXT",
  "ALTER TABLE messages ADD COLUMN attachment_type TEXT",
  "ALTER TABLE users ADD COLUMN business_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE channels ADD COLUMN username TEXT",
  "ALTER TABLE channels ADD COLUMN photo_url TEXT",
  "ALTER TABLE channels ADD COLUMN slow_mode INTEGER DEFAULT 0",
  "ALTER TABLE channels ADD COLUMN only_admins_post INTEGER DEFAULT 0",
  "ALTER TABLE channels ADD COLUMN hide_members INTEGER DEFAULT 0",
];
for (const sql of migrationColumns) {
  try {
    db.exec(sql);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Nyx backend expansion: channels, groups, bots, sync, media,
// notifications, stories, premium, privacy and audit logs.
// These tables are additive and do not break the existing mobile client.
// ─────────────────────────────────────────────────────────────────────────────
function addColumnIfMissing(sql) {
  try { db.exec(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

function tableColumns(tableName) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
  } catch (e) {
    return new Set();
  }
}

function tableHasColumns(tableName, columns) {
  const existing = tableColumns(tableName);
  return columns.every((column) => existing.has(column));
}

function createIndexIfColumns(indexName, tableName, columnsSql, requiredColumns = null, whereSql = '') {
  const required = requiredColumns || columnsSql
    .split(',')
    .map((value) => value.trim().split(/\s+/)[0])
    .filter(Boolean);
  if (!tableHasColumns(tableName, required)) {
    return;
  }
  const where = whereSql ? ` ${whereSql}` : '';
  db.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${columnsSql})${where}`);
}

function createUniqueIndexIfColumns(indexName, tableName, columnsSql, requiredColumns = null, whereSql = '') {
  const required = requiredColumns || columnsSql
    .split(',')
    .map((value) => value.trim().split(/\s+/)[0])
    .filter(Boolean);
  if (!tableHasColumns(tableName, required)) {
    return;
  }
  const where = whereSql ? ` ${whereSql}` : '';
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${columnsSql})${where}`);
}

function backfillMissingTimestamp(tableName, columnName) {
  if (tableHasColumns(tableName, [columnName])) {
    try { db.exec(`UPDATE ${tableName} SET ${columnName} = datetime('now') WHERE ${columnName} IS NULL`); } catch (e) {}
  }
}

[
  "ALTER TABLE channels ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'",
  "ALTER TABLE channels ADD COLUMN protected_content INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE channels ADD COLUMN linked_discussion_group_id INTEGER",
  "ALTER TABLE channels ADD COLUMN default_reaction_enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE channels ADD COLUMN signatures_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE channels ADD COLUMN auto_delete_seconds INTEGER",
  "ALTER TABLE channels ADD COLUMN updated_at TEXT",
  "ALTER TABLE channels ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE channel_messages ADD COLUMN media_json TEXT",
  "ALTER TABLE channel_messages ADD COLUMN entities_json TEXT",
  "ALTER TABLE channel_messages ADD COLUMN silent INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE channel_messages ADD COLUMN protected_content INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE channel_messages ADD COLUMN scheduled_at TEXT",
  "ALTER TABLE channel_messages ADD COLUMN published_at TEXT",
  "ALTER TABLE channel_messages ADD COLUMN edit_history_json TEXT",
  "ALTER TABLE channel_messages ADD COLUMN deleted_at TEXT",
  "ALTER TABLE groups ADD COLUMN group_type TEXT NOT NULL DEFAULT 'group'",
  "ALTER TABLE groups ADD COLUMN slow_mode_seconds INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE groups ADD COLUMN join_approval_required INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE groups ADD COLUMN protected_content INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE groups ADD COLUMN permissions_json TEXT",
  "ALTER TABLE groups ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE groups ADD COLUMN username TEXT",
  "ALTER TABLE groups ADD COLUMN photo_url TEXT",
  "ALTER TABLE groups ADD COLUMN linked_channel_id INTEGER",
  "ALTER TABLE groups ADD COLUMN updated_at TEXT",
  "ALTER TABLE group_messages ADD COLUMN topic_id INTEGER",
  "ALTER TABLE group_messages ADD COLUMN reply_to_message_id INTEGER",
  "ALTER TABLE group_messages ADD COLUMN media_json TEXT",
  "ALTER TABLE group_messages ADD COLUMN entities_json TEXT",
  "ALTER TABLE group_messages ADD COLUMN edited_at TEXT",
  "ALTER TABLE group_messages ADD COLUMN deleted_at TEXT",
  "ALTER TABLE user_sessions ADD COLUMN push_token TEXT",
  "ALTER TABLE user_sessions ADD COLUMN app_version TEXT",
  "ALTER TABLE user_sessions ADD COLUMN ip_hash TEXT",
  "ALTER TABLE user_sessions ADD COLUMN revoked_at TEXT",
  "ALTER TABLE users ADD COLUMN created_at TEXT",
  "ALTER TABLE conversations ADD COLUMN created_at TEXT",
  "ALTER TABLE messages ADD COLUMN created_at TEXT",
  "ALTER TABLE channels ADD COLUMN created_at TEXT",
  "ALTER TABLE channel_messages ADD COLUMN created_at TEXT",
  "ALTER TABLE group_messages ADD COLUMN created_at TEXT",
  "ALTER TABLE group_members ADD COLUMN joined_at TEXT",
  "ALTER TABLE user_sessions ADD COLUMN created_at TEXT",
  "ALTER TABLE user_sessions ADD COLUMN last_active TEXT"
].forEach(addColumnIfMissing);

[
  ['users', 'created_at'],
  ['conversations', 'created_at'],
  ['messages', 'created_at'],
  ['channels', 'created_at'],
  ['channel_messages', 'created_at'],
  ['group_messages', 'created_at'],
  ['group_members', 'joined_at'],
  ['user_sessions', 'created_at'],
  ['user_sessions', 'last_active']
].forEach(([table, column]) => backfillMissingTimestamp(table, column));

db.exec(`
  CREATE TABLE IF NOT EXISTS channel_admin_rights (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    can_post INTEGER NOT NULL DEFAULT 1,
    can_edit INTEGER NOT NULL DEFAULT 1,
    can_delete INTEGER NOT NULL DEFAULT 1,
    can_manage_subscribers INTEGER NOT NULL DEFAULT 0,
    can_manage_admins INTEGER NOT NULL DEFAULT 0,
    can_manage_settings INTEGER NOT NULL DEFAULT 0,
    can_view_stats INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channel_bans (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    banned_by INTEGER NOT NULL REFERENCES users(id),
    reason TEXT,
    banned_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channel_post_views (
    message_id INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channel_post_reactions (
    message_id INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    is_premium INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS channel_post_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    reply_to_comment_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    edited_at TEXT,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS channel_pins (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    pinned_by INTEGER NOT NULL REFERENCES users(id),
    pinned_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS channel_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS channel_join_requests (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    icon TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    is_closed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_bans (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    banned_by INTEGER NOT NULL REFERENCES users(id),
    reason TEXT,
    banned_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_mutes (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    muted_by INTEGER NOT NULL REFERENCES users(id),
    muted_until TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_join_requests (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_message_reactions (
    message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    is_premium INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS group_pins (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
    pinned_by INTEGER NOT NULL REFERENCES users(id),
    pinned_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS group_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    about TEXT,
    avatar_path TEXT,
    token_hash TEXT NOT NULL,
    token_preview TEXT NOT NULL,
    webhook_url TEXT,
    webhook_secret TEXT,
    inline_mode INTEGER NOT NULL DEFAULT 0,
    can_join_groups INTEGER NOT NULL DEFAULT 1,
    can_read_all_group_messages INTEGER NOT NULL DEFAULT 0,
    payments_enabled INTEGER NOT NULL DEFAULT 0,
    mini_app_url TEXT,
    is_support_bot INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS bot_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    command TEXT NOT NULL,
    description TEXT NOT NULL,
    scope TEXT DEFAULT 'default',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bot_id, command, scope)
  );

  CREATE TABLE IF NOT EXISTS bot_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    update_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bot_group_rights (
    bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    can_delete_messages INTEGER NOT NULL DEFAULT 0,
    can_ban_users INTEGER NOT NULL DEFAULT 0,
    can_pin_messages INTEGER NOT NULL DEFAULT 0,
    can_manage_topics INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (bot_id, group_id)
  );

  CREATE TABLE IF NOT EXISTS media_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    file_path TEXT NOT NULL,
    original_name TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    width INTEGER,
    height INTEGER,
    duration_seconds REAL,
    encrypted INTEGER NOT NULL DEFAULT 0,
    encryption_meta_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS link_previews (
    url TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    image_url TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS push_tokens (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    platform TEXT,
    device_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, token)
  );

  CREATE TABLE IF NOT EXISTS notification_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL DEFAULT 'global',
    scope_id TEXT NOT NULL DEFAULT 'global',
    muted_until TEXT,
    sound TEXT DEFAULT 'default',
    show_preview INTEGER NOT NULL DEFAULT 1,
    mentions_only INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, scope_type, scope_id)
  );

  CREATE TABLE IF NOT EXISTS secret_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a_id INTEGER NOT NULL REFERENCES users(id),
    user_b_id INTEGER NOT NULL REFERENCES users(id),
    key_fingerprint TEXT NOT NULL,
    qr_payload TEXT,
    auto_delete_seconds INTEGER,
    screenshot_protection INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_a_id, user_b_id, key_fingerprint)
  );

  CREATE TABLE IF NOT EXISTS user_privacy_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    hide_phone INTEGER NOT NULL DEFAULT 1,
    hide_online INTEGER NOT NULL DEFAULT 1,
    sealed_sender INTEGER NOT NULL DEFAULT 1,
    strip_media_metadata INTEGER NOT NULL DEFAULT 1,
    protect_forwards INTEGER NOT NULL DEFAULT 1,
    screenshot_guard INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_cloud_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS user_saved_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, item_type, item_id)
  );

  CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_type TEXT NOT NULL DEFAULT 'user',
    author_id INTEGER NOT NULL,
    media_url TEXT NOT NULL,
    caption TEXT,
    privacy TEXT NOT NULL DEFAULT 'contacts',
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS story_views (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (story_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS story_reactions (
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (story_id, user_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS premium_products (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    price_nyx INTEGER NOT NULL DEFAULT 0,
    product_type TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS premium_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    product_id TEXT NOT NULL REFERENCES premium_products(id),
    status TEXT NOT NULL DEFAULT 'active',
    purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  );

`);

createUniqueIndexIfColumns('idx_active_listing_username', 'username_listings', 'listed_username', ['listed_username', 'status'], "WHERE status = 'active'");

// Safe index creation for old SQLite volumes.
// The server may boot with a database created by older Nyx builds where some
// columns do not exist yet. Indexes are created only when all referenced columns
// are present, so startup never crashes on legacy data.
createIndexIfColumns('idx_channel_post_views_message', 'channel_post_views', 'message_id');
createIndexIfColumns('idx_channel_post_reactions_message', 'channel_post_reactions', 'message_id');
createIndexIfColumns('idx_channel_comments_message', 'channel_post_comments', 'message_id, created_at');
createIndexIfColumns('idx_bots_owner', 'bots', 'owner_id');
createIndexIfColumns('idx_bot_updates_pending', 'bot_updates', 'bot_id, delivered, id');
createIndexIfColumns('idx_media_owner', 'media_files', 'owner_id, created_at');

createIndexIfColumns('idx_users_username', 'users', 'username');
createIndexIfColumns('idx_users_created_at', 'users', 'created_at');
createIndexIfColumns('idx_conversations_user_a', 'conversations', 'user_a_id, created_at');
createIndexIfColumns('idx_conversations_user_b', 'conversations', 'user_b_id, created_at');
createIndexIfColumns('idx_messages_conversation', 'messages', 'conversation_id, created_at');
createIndexIfColumns('idx_messages_sender_created', 'messages', 'sender_id, created_at');
createIndexIfColumns('idx_messages_type_created', 'messages', 'message_type, created_at');
createIndexIfColumns('idx_channels_owner', 'channels', 'owner_id, created_at');
createIndexIfColumns('idx_channels_username', 'channels', 'username');
createIndexIfColumns('idx_channels_public', 'channels', 'visibility, created_at');
createIndexIfColumns('idx_channel_subscriptions_user', 'channel_subscriptions', 'user_id, subscribed_at');
createIndexIfColumns('idx_channel_messages', 'channel_messages', 'channel_id, created_at');
createIndexIfColumns('idx_channel_messages_sender', 'channel_messages', 'sender_id, created_at');
createIndexIfColumns('idx_channel_admins_user', 'channel_admins', 'user_id');
createIndexIfColumns('idx_channel_bans_user', 'channel_bans', 'user_id, banned_until');
createIndexIfColumns('idx_channel_join_requests_channel', 'channel_join_requests', 'channel_id, status, created_at');
createIndexIfColumns('idx_group_members_user', 'group_members', 'user_id, joined_at');
createIndexIfColumns('idx_group_messages', 'group_messages', 'group_id, created_at');
createIndexIfColumns('idx_group_messages_sender', 'group_messages', 'sender_id, created_at');
createIndexIfColumns('idx_group_topics_group', 'group_topics', 'group_id, created_at');
createIndexIfColumns('idx_group_bans_user', 'group_bans', 'user_id, banned_until');
createIndexIfColumns('idx_group_mutes_user', 'group_mutes', 'user_id, muted_until');
createIndexIfColumns('idx_group_join_requests_group', 'group_join_requests', 'group_id, status, created_at');
createIndexIfColumns('idx_group_message_reactions_message', 'group_message_reactions', 'message_id');
createIndexIfColumns('idx_user_sessions_user_active', 'user_sessions', 'user_id, revoked_at, last_active');
createIndexIfColumns('idx_push_tokens_user', 'push_tokens', 'user_id, platform');
createIndexIfColumns('idx_notification_settings_user_scope', 'notification_settings', 'user_id, scope_type, scope_id');
createIndexIfColumns('idx_saved_items_user', 'user_saved_items', 'user_id, created_at');
createIndexIfColumns('idx_stories_author_created', 'stories', 'author_type, author_id, created_at');
createIndexIfColumns('idx_story_views_user', 'story_views', 'user_id, viewed_at');
createIndexIfColumns('idx_premium_purchases_user', 'premium_purchases', 'user_id, status, purchased_at');


// Ensure Nyx Support bot product/catalog rows exist without requiring manual SQL.
try {
  db.prepare(`INSERT OR IGNORE INTO premium_products (id, title, description, price_nyx, product_type, payload_json)
    VALUES
      ('nyx_premium_month', 'Nyx Premium месяц', 'Premium-значки, реакции, оформление и повышенные лимиты', 499, 'subscription', '{}'),
      ('nyx_channel_boost', 'Буст канала', 'Повышение лимитов канала и premium-оформление', 250, 'boost', '{}'),
      ('nyx_sticker_slot', 'Слот стикер-пака', 'Дополнительный пользовательский стикер-пак', 150, 'sticker', '{}')`).run();
} catch (e) {}

// Enterprise production/UI extension columns
[
  "ALTER TABLE stories ADD COLUMN close_friends_json TEXT",
  "ALTER TABLE stories ADD COLUMN archived_at TEXT",
  "ALTER TABLE stories ADD COLUMN edited_at TEXT",
  "ALTER TABLE stories ADD COLUMN deleted_at TEXT",
  "ALTER TABLE sticker_packs ADD COLUMN published INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sticker_packs ADD COLUMN moderated INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sticker_packs ADD COLUMN price_nyx INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sticker_pack_items ADD COLUMN asset_type TEXT",
  "ALTER TABLE sticker_pack_items ADD COLUMN video_url TEXT"
].forEach(addColumnIfMissing);

module.exports = db;
