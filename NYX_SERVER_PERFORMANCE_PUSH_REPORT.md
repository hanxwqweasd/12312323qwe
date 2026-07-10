# Nyx Server Performance / Release Patch

Добавлено и исправлено:

- SQLite fallback ускорен: WAL, NORMAL synchronous, busy timeout, memory temp store, увеличенный cache_size.
- Добавлены индексы для пользователей, диалогов, сообщений, каналов, групп, сессий, stories, media, уведомлений, premium и saved items.
- Добавлен performance middleware: request id, slow-request logging, request/headers/keep-alive timeout tuning.
- Добавлены кеширующие заголовки для статических media/avatars.
- Добавлен graceful shutdown для API, Redis, PostgreSQL pool.
- Добавлен SQLite maintenance scheduler: `PRAGMA optimize` и WAL checkpoint.
- Добавлены not found/error middleware с requestId.
- Dockerfile переведён на `npm ci --omit=dev`, добавлен healthcheck.
- Удалён `.env`, добавлен `.env.example`, `.gitignore`, `.dockerignore`, `.npmrc`.
- Убраны внутренние OpenAI registry-ссылки из package-lock.json.
- Добавлен nginx reverse proxy config с websocket support.
- Добавлен PM2 ecosystem для cluster mode.
- Добавлены scripts: syntax check, healthcheck, sqlite backup, postgres backup/restore.
- Добавлены docs: deployment, backup/restore, performance.
- Добавлен GitHub Actions workflow `server-check.yml`.

Проверки:

- `npm run check:syntax` — passed, 49 JS files.
- `package.json` / `package-lock.json` — валидный JSON.
- `.env` не включён.
- Внутренних registry-ссылок нет.

GitHub push:

- Через подключённую GitHub-интеграцию запись невозможна: GitHub возвращает `Resource not accessible by integration`.
- Для пуша подготовлен отдельный push-kit со скриптами Windows/Linux.
