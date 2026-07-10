# Performance changes

Added:

- SQLite WAL + NORMAL synchronous + busy timeout + memory temp store + larger cache.
- Extra indexes for users, conversations, messages, channels, groups, sessions, stories, media and notifications.
- Request IDs and slow-request logging.
- Keep-alive/header/request timeout tuning.
- Static media caching headers.
- Docker `npm ci` build for deterministic faster container builds.
- Nginx reverse proxy config with websocket support.
- Socket.io Redis adapter support.
- BullMQ workers for push/media/bot/backups.
- Healthcheck and graceful shutdown.
