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
