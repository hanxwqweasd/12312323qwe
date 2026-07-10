# Nyx Server SQLite Migration Fix

## Исправлено

Контейнер падал на старте с ошибкой:

```text
SqliteError: no such column: is_public
at Object.<anonymous> (/app/src/db.js:334:4)
```

Причина: production/performance index создавался по колонке `channels.is_public`, которой нет в текущей схеме каналов. Каналы используют поле `visibility` (`public` / `private`). Из-за этого `db.exec()` падал во время инициализации базы, контейнер перезапускался циклом.

## Что изменено

- Индекс `idx_channels_public` теперь создаётся по `channels(visibility, created_at)`.
- Некорректный индекс `stories(owner_id, created_at)` заменён на `stories(author_type, author_id, created_at)`.
- Добавлены миграции для старых SQLite-баз, где у `groups` могли отсутствовать `is_public`, `username`, `photo_url`.
- `package-lock.json` не включён, чтобы Docker использовал `npm install` и не падал из-за рассинхронизации lock-файла.
- `.env` не включён в архив.
- JS-синтаксис сервера проверен через `node --check`.

## Проверка после деплоя

```bash
curl http://localhost:3000/health
curl http://localhost:3000/production/status
curl http://localhost:3000/production/readiness
```

Если на сервере уже есть старый SQLite-файл, этот патч применит недостающие `ALTER TABLE` автоматически при старте.
