# Nyx Server

Production-oriented Nyx backend: API, Socket.io, queues, media storage, push workers, backups and deployment files.

## Fast local start

```bash
npm install
npm start
```

## Production start

```bash
cp .env.example .env
# change secrets in .env
docker compose -f docker-compose.production.yml up --build
```

Check:

```bash
curl http://localhost/health
curl http://localhost/production/status
curl http://localhost/production/readiness
```

## Important before public launch

Change all secrets: `JWT_SECRET`, database password, MinIO credentials, TURN credentials, `IP_HASH_SALT`, domain and HTTPS reverse proxy settings.
Do not commit `.env`.


## Docker install fix

This build intentionally does **not** copy `package-lock.json` into the Docker image.
The previous lock file was stale after adding production dependencies (`pg`, `ioredis`, `bullmq`, `@aws-sdk/*`, `pino`, etc.), so `npm ci` failed with `package.json and package-lock.json are not in sync`.

The Dockerfile now uses:

```bash
npm install --omit=dev --no-audit --no-fund --prefer-online
```

After a successful local install you may regenerate a clean lock file manually:

```bash
npm install --package-lock-only --no-audit --no-fund
```

Do not commit an old/stale lock file.
