# Docker deployment

GitHub Actions publishes one multi-platform image for `linux/amd64` and `linux/arm64` to GitHub Container Registry (GHCR).

## Image tags

```text
ghcr.io/jhxxr/occ:main
ghcr.io/jhxxr/occ:sha-<commit>
ghcr.io/jhxxr/occ:<version>
```

`latest` is published from `main` and stable semantic-version tags. SHA tags are recommended for reproducible deployments.

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

A deployment is one self-contained directory. `compose.yml` and `.env` sit at the top; SQLite lives in `./data` next to them.

```text
occ/
├── compose.yml
├── .env          # secrets; never commit or share
└── data/         # created on first start; holds orbit.db
```

Create the directory and fetch `compose.yml`:

```bash
mkdir -p ~/occ && cd ~/occ
curl -fsSL https://raw.githubusercontent.com/jhxxr/occ/main/compose.yml -o compose.yml
```

Write a local `.env` that is never committed. Generate each secret separately, for example with `openssl rand -hex 32`:

```dotenv
ENCRYPTION_SECRET=<random value>
AUTH_USERNAME=admin
AUTH_PASSWORD=<strong password>
AUTH_SECRET=<different random value>
```

`ORBIT_IMAGE` and `ORBIT_PORT` are optional overrides. They default to `ghcr.io/jhxxr/occ:latest` and `3000`; set `ORBIT_IMAGE` to a SHA or version tag to pin production, and `ORBIT_PORT` to publish on a different host port. `DEFAULT_USD_CNY` defaults to `7.2`.

Then start the service:

```bash
docker compose pull
docker compose up -d
```

The bind mount at `./data` persists application data, so backing up the deployment directory captures both configuration and data. The entrypoint runs `prisma db push` before starting Next.js and exits if schema synchronization fails. It intentionally does **not** accept destructive schema changes: if an image rollback would remove tables or columns created by a newer release, startup stops and leaves the database untouched.

Before changing versions, stop the service and copy `./data` to a dated backup. Rolling the application image back does not roll the database schema back; use a database backup made by the target version when a downgrade requires an older schema.

If the container cannot write to `./data`, check `docker compose logs orbit` for a permission error and adjust ownership on the host directory to match the container user.

## Upgrading extension tokens

Before deploying an image that contains the `hash_extension_tokens` migration, back up `./data`. The migration preserves application/provider data but intentionally revokes every legacy extension inject token because plaintext tokens cannot be safely converted to one-way hashes in SQLite migration SQL.

After the upgrade:

- Sign in and create replacement extension tokens.
- Save each token when it is created; it is shown only once.
- Configure extensions to send `X-Orbit-Token` or `Authorization: Bearer`.
- Do not reuse old `?token=...` URLs; query-string authentication is no longer accepted.

## Operations

- Stop the service and back up the deployment directory before changing image versions; archiving `occ/` captures `compose.yml`, `.env`, and `./data` together.
- Moving a deployment is a directory copy plus `docker compose up -d` on the new host.
- Run a single writable application instance per SQLite database.
- Put a TLS-enabled reverse proxy in front of port 3000 before public exposure.
- Pin a SHA or version tag for production. For rollback, restore the matching database backup as well as the image when the schema changed between versions.
- Review `docker compose logs orbit` after each upgrade to confirm migrations and startup succeeded.
