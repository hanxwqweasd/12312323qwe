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

  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

  -- Каналы — открытое вещание (НЕ E2E, в отличие от личных сообщений выше).
  -- Это сознательное решение: настоящее сквозное шифрование для broadcast
  -- одному сообщению на N произвольных подписчиков требует протокола вроде
  -- Signal Sender Keys/MLS — отдельная большая система. Telegram устроен
  -- так же: обычные каналы не E2E, зашифрованы только Secret Chats один-на-один
  -- (у нас это и есть личные сообщения выше).
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

  CREATE INDEX IF NOT EXISTS idx_channel_messages ON channel_messages(channel_id, created_at);

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

  -- Гарантирует не более одного АКТИВНОГО листинга на одну и ту же строку
  -- юзернейма одновременно (частичный уникальный индекс — поддерживается SQLite).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_active_listing_username
    ON username_listings(listed_username) WHERE status = 'active';
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
];
for (const sql of migrationColumns) {
  try {
    db.exec(sql);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

module.exports = db;
