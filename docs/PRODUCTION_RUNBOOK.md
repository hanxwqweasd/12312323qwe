# NYX production runbook

## Быстрый production-stack

```bash
cp .env.example .env
# поменять JWT_SECRET, пароли, домены и ключи
docker compose -f docker-compose.production.yml up --build
```

## Миграции PostgreSQL

```bash
npm run migrate:pg
```

## Worker'ы

```bash
npm run worker:push
npm run worker:media
npm run worker:bot-updates
npm run worker:backups
```

## Проверка готовности

```bash
curl http://localhost:3000/production/status
curl http://localhost:3000/production/readiness
```

## Важные замечания

- SQLite оставлен как fallback для локального теста.
- Для реального продакшена включи `DB_DRIVER=postgres`, `DATABASE_URL`, `REDIS_URL`, `S3_*`.
- TURN/coturn нужен для стабильных звонков за NAT.
- CDN лучше ставить перед MinIO/S3 для быстрой отдачи медиа.
- Push worker учитывает muted settings и silent payload.
