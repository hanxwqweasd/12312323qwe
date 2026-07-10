# Nyx deployment checklist

1. Create a VPS with at least 2 CPU / 4 GB RAM for test launch.
2. Install Docker and Docker Compose.
3. Clone the repository.
4. Copy `.env.example` to `.env`.
5. Replace all `change_me` values.
6. Run `docker compose -f docker-compose.production.yml up --build -d`.
7. Run migrations: the API container runs `npm run migrate:pg` on startup.
8. Check `/health`, `/production/status`, `/production/readiness`.
9. Point app `API_BASE_URL` to the public HTTPS domain.
10. Enable backups and monitor logs.

For a real public release use HTTPS, external object storage/CDN, managed PostgreSQL backups and real push credentials.
