# Generic Docker Image

This guide covers the production Docker image outside the bundled VPS Compose files.

The image contains the built admin UI, Bun server, public renderer, CMS API routes, migrations, and runtime dependencies. It does not run Vite or install packages at container startup.

---

## TL;DR

Run the image with:

- `PORT` set to the platform's HTTP port
- `DATABASE_URL` pointing at SQLite or Postgres
- `UPLOADS_DIR` mounted on persistent storage
- `STATIC_DIR=/app/dist`
- `INSTATIC_SECRET_KEY` set before configuring AI provider credentials, plugin secret settings, or TOTP MFA
- `PUBLIC_ORIGIN` set to the site's public origin when the platform terminates HTTPS before forwarding to the container (auto-detected from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN` on those platforms)

Use one persistent mount root when the platform only supports one app volume:

```txt
DATABASE_URL=sqlite:/app/storage/data/cms.db
UPLOADS_DIR=/app/storage/uploads
```

## Build Locally

The image is always built from this repository:

```sh
docker build -t instatic:local .
```

## Run With SQLite

Use this mode when the host can attach a persistent volume to the app container.

```sh
docker volume create instatic-storage

docker run -d \
  --name instatic \
  -p 3001:3001 \
  -e PORT=3001 \
  -e DATABASE_URL="sqlite:/app/storage/data/cms.db" \
  -e STATIC_DIR=/app/dist \
  -e UPLOADS_DIR=/app/storage/uploads \
  -e INSTATIC_SECRET_KEY="replace-with-output-of-generate-secret-key" \
  -v instatic-storage:/app/storage \
  --restart unless-stopped \
  instatic:local
```

The single volume stores both the SQLite database and uploaded media.

## Run With External Postgres

Use this mode when Postgres is provided by the host or by a separate managed database service.

```sh
docker volume create instatic-storage

docker run -d \
  --name instatic \
  -p 3001:3001 \
  -e PORT=3001 \
  -e DATABASE_URL="postgres://user:password@host:5432/instatic" \
  -e STATIC_DIR=/app/dist \
  -e UPLOADS_DIR=/app/storage/uploads \
  -e INSTATIC_SECRET_KEY="replace-with-output-of-generate-secret-key" \
  -v instatic-storage:/app/storage \
  --restart unless-stopped \
  instatic:local
```

The app volume is still required in Postgres mode because uploads, fonts, plugin packs, and published disk artefacts live under `UPLOADS_DIR`.

## Required Runtime Variables

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | Yes | `sqlite:...`, `file:...`, `postgres://...`, or `postgresql://...` |
| `UPLOADS_DIR` | Yes for durable media | Persistent upload directory |
| `STATIC_DIR` | Yes in Docker | `/app/dist` |
| `PORT` | Platform-dependent | HTTP listen port; defaults to `3001` |
| `HOST` | Optional | Bind address; defaults to `0.0.0.0`. set `127.0.0.1` to keep a local instance off the LAN |
| `INSTATIC_SECRET_KEY` | Yes for reversible server secrets | Output of `bun run scripts/generate-secret-key.ts` |
| `PUBLIC_ORIGIN` | Behind managed HTTPS proxies | Comma-separated public origins for the CSRF check, e.g. `https://www.example.com`. Auto-detected from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN` on those platforms |
| `TRUSTED_PROXY_CIDRS` | Optional | Comma-separated trusted proxy CIDRs for client-IP attribution only (audit logs, rate-limit keys) — **not** used for CSRF. Trust only your real proxy CIDRs; never `0.0.0.0/0` for a public service |

Managed platforms usually inject `PORT`. Do not hard-code a different listen port unless the platform asks for a fixed target port.

Managed HTTPS platforms often terminate TLS before forwarding HTTP to the container, so the container sees plain HTTP. Set `PUBLIC_ORIGIN` to the site's public origin for those deployments so the CSRF origin check compares against the real public origin instead of the container-local request URL. Render and Railway are auto-detected (`RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN`), so a one-click deploy needs no manual value; set `PUBLIC_ORIGIN` explicitly when you add a custom domain (append it as a second comma-separated entry).

`INSTATIC_SECRET_KEY` is the stable AES master key for reversible server secrets, including Anthropic, OpenAI, and OpenRouter credentials and TOTP MFA seeds. If it is missing in production, adding a credential or enabling TOTP MFA fails. If it is rotated or lost, existing stored credentials must be re-entered and TOTP MFA must be re-enrolled.

## Health Check

```sh
curl http://localhost:3001/health
```

Expected response:

```json
{"status":"ok","ts":1234567890}
```

## Related

- [deployment/README.md](README.md) — deployment overview
- [vps.md](vps.md) — Docker Compose install
- [backup-restore.md](backup-restore.md) — backing up DB and uploads
- `Dockerfile` — production image definition
- `server/config.ts` — runtime env parsing
