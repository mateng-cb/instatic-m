# Deployment

This index maps supported deployment targets to the files, variables, and persistence rules they need.

Instatic is one Bun server packaged by the root `Dockerfile`. The server reads runtime configuration from `server/config.ts`: `PORT`, `DATABASE_URL`, `UPLOADS_DIR`, `STATIC_DIR`, `PUBLIC_ORIGIN`, and `TRUSTED_PROXY_CIDRS`. Reversible server secrets, including AI provider credentials, plugin secret settings, GitHub publish PATs, and MFA TOTP seeds, are encrypted with `INSTATIC_SECRET_KEY` when configured. Database migrations run automatically on boot in `server/index.ts`.

---

## TL;DR

| Target | Use when | Database | Persistent storage | Docs |
|---|---|---|---|---|
| VPS Docker Compose | Self-hosted server, full control | SQLite or bundled Postgres | Docker named volumes | [vps.md](vps.md) |
| Generic Docker host | Any platform that runs the Dockerfile/image | SQLite or external Postgres | A mounted directory/volume for DB/uploads | [docker-image.md](docker-image.md) |
| VPS HTTPS | Public domain on a VPS | Unchanged | Caddy cert volume plus app volumes | [tls-caddy.md](tls-caddy.md) |
| Multi-site VPS | Several independent sites, one server, shared image | SQLite per site | Per-site data + uploads directories (one Compose project per site) | [multi-site.md](multi-site.md) |
| Local multi-site dev | Developing several sites on one machine before launch | SQLite per site (`.sites/<site>/`) | Per-site local workspace directories | [local-workspaces.md](local-workspaces.md) |
| GitHub Pages | Static export to a GitHub branch (no Bun on Pages) | N/A (export is read from published slot) | PAT encrypted in DB; requires `INSTATIC_SECRET_KEY` | [github-pages.md](github-pages.md) |

Back up both the database and uploaded media. See [backup-restore.md](backup-restore.md).

## Runtime Contract

Every deployment target configures the same process:

```txt
PORT          HTTP port the Bun server listens on
DATABASE_URL  sqlite:/path/to/cms.db, file:/path/to/cms.db, postgres://..., or postgresql://...
UPLOADS_DIR   directory for media, plugin packs, fonts, and published disk artefacts
STATIC_DIR    built admin SPA directory; /app/dist in the Docker image
INSTATIC_SECRET_KEY  base64 32-byte key for encrypted server secrets
PUBLIC_ORIGIN        comma-separated public origin(s) the CSRF check trusts; auto-detected from RENDER_EXTERNAL_URL / RAILWAY_PUBLIC_DOMAIN on those platforms
TRUSTED_PROXY_CIDRS  optional; trusts proxy socket peers for forwarded client-IP attribution only (audit logs, rate-limit keys) — NOT used for CSRF
```

Generate `INSTATIC_SECRET_KEY` with `bun run scripts/generate-secret-key.ts` before adding Anthropic, OpenAI, or OpenRouter credentials or enabling TOTP MFA in production. Without it, the admin can load but saving reversible secrets fails because there is no stable encryption key.

The Docker image sets:

```txt
PORT=3001
STATIC_DIR=/app/dist
UPLOADS_DIR=/app/uploads
```

Managed platforms often override `PORT`. That is fine; the server uses `process.env.PORT`. When a managed platform terminates HTTPS before forwarding HTTP to the container, the CSRF origin check derives the site's public origin from `PUBLIC_ORIGIN` — auto-detected from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN` on Render and Railway, so one-click deploys need no manual value. Set `PUBLIC_ORIGIN` explicitly (a comma-separated list) when adding a custom domain. `TRUSTED_PROXY_CIDRS` is independent of CSRF and only attributes the real client IP for audit logs and rate-limit keys.

## Image Availability

The image is always built from this repository — `compose.prod.yml` carries the `build` context, so Compose builds it on first `up` and on every `--build`:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml up -d --build
```

Override the resulting tag with `INSTATIC_IMAGE` when you push it to your own registry.

## Database Choice

The database engine is selected only by `DATABASE_URL`:

| URL shape | Engine |
|---|---|
| `sqlite:/path/to/cms.db` | SQLite |
| `file:/path/to/cms.db` | SQLite |
| `/path/to/cms.db` | SQLite |
| `postgres://...` | Postgres |
| `postgresql://...` | Postgres |

SQLite is the default for single-site installs. Postgres is for multiple simultaneous admin writers, more than one app container, or operators who already want managed Postgres.

## Persistence Rules

`UPLOADS_DIR` is required for durable media regardless of the database engine. It stores:

- uploaded media originals and variants
- uploaded fonts
- plugin packages and module packs
- published static artefacts under `published/current`

SQLite installs also need the SQLite database file on persistent storage. On platforms with only one app volume, put both the SQLite file and uploads under the same mounted root.

## Docs Inventory

| File | Role |
|---|---|
| [vps.md](vps.md) | Docker Compose on a VPS, both SQLite and Postgres |
| [docker-image.md](docker-image.md) | Generic Docker image contract and `docker run` examples |
| [tls-caddy.md](tls-caddy.md) | Caddy TLS overlay for VPS Compose installs |
| [multi-site.md](multi-site.md) | Multi-site: one Instatic instance per site behind host Nginx |
| [local-workspaces.md](local-workspaces.md) | Local multi-site development: per-site dev workspaces, launch upload, snapshot pull |
| [backup-restore.md](backup-restore.md) | Database and uploads backup/restore |
| [github-pages.md](github-pages.md) | GitHub Pages static publish (PAT, branch, `basePath`) |

## Related

- `server/config.ts` — runtime env parsing
- `server/db/index.ts` — database URL detection
- `server/index.ts` — migrations, media storage, and server boot
- `Dockerfile` — production image contract
- `compose.prod.yml`, `compose.sqlite.yml`, `compose.tls.yml` — VPS Compose files
