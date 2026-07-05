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
`);

module.exports = db;
