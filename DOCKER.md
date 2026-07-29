# Docker deployment

GitHub Actions publishes one multi-platform image for `linux/amd64` and `linux/arm64` to GitHub Container Registry (GHCR).

## Image tags

Replace `OWNER/REPOSITORY` with the lowercase GitHub repository path:

```text
ghcr.io/owner/repository:main
ghcr.io/owner/repository:sha-<commit>
ghcr.io/owner/repository:<version>
```

`latest` is published only from `main` and stable semantic-version tags. SHA tags are recommended for reproducible deployments.

## Required runtime configuration

The image contains no application credentials. Supply all of these at runtime:

- `ENCRYPTION_SECRET`: long random value used to encrypt stored provider credentials.
- `AUTH_USERNAME`: private administrator username.
- `AUTH_PASSWORD`: strong administrator password.
- `AUTH_SECRET`: independent long random value used to sign session cookies.
- `DATABASE_URL`: defaults to `file:/app/data/orbit.db` in the image.
- `DEFAULT_USD_CNY`: optional; defaults to `7.2`.

Do not change `ENCRYPTION_SECRET` for an existing database unless stored credentials are deliberately re-encrypted first.

## Docker Compose

Create a local `.env` that is never committed:

```dotenv
ORBIT_IMAGE=ghcr.io/owner/repository:sha-0123456
ORBIT_PORT=3000
ENCRYPTION_SECRET=<random value>
AUTH_USERNAME=admin
AUTH_PASSWORD=<strong password>
AUTH_SECRET=<different random value>
DEFAULT_USD_CNY=7.2
```

Then start the service:

```bash
docker compose pull
docker compose up -d
```

The named `orbit-data` volume persists SQLite at `/app/data/orbit.db`. The entrypoint runs `prisma migrate deploy` before starting Next.js and exits if a migration fails.

## Upgrading extension tokens

Before deploying an image that contains the `hash_extension_tokens` migration, back up the SQLite volume. The migration preserves application/provider data but intentionally revokes every legacy extension inject token because plaintext tokens cannot be safely converted to one-way hashes in SQLite migration SQL.

After the upgrade:

- Sign in and create replacement extension tokens.
- Save each token when it is created; it is shown only once.
- Configure extensions to send `X-Orbit-Token` or `Authorization: Bearer`.
- Do not reuse old `?token=...` URLs; query-string authentication is no longer accepted.

## Operations

- Back up the SQLite volume before changing image versions.
- Run a single writable application instance per SQLite database.
- Put a TLS-enabled reverse proxy in front of port 3000 before public exposure.
- Pin a SHA or version tag for production; do not depend on a mutable tag for rollbacks.
- Review `docker compose logs orbit` after each upgrade to confirm migrations and startup succeeded.
