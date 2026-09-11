# Multi-Site Deployment (one instance per site)

Several independent sites run on one VPS from the same Docker image. Each site
is a full, isolated Instatic instance: its own container, its own SQLite
database, its own uploads directory, its own admin accounts. An Nginx on the
host dispatches by domain; TLS terminates on the Huawei Cloud ELB in front.

**The VPS instances are CMS admin backends only.** Public sites are served by
Cloudflare Pages, which pulls each site's GitHub export — the VPS never faces
visitor traffic. See [ADR 0002](../adr/0002-cms-origins-admin-only-static-export.md)
for why, and [github-pages.md](github-pages.md) for the export pipeline.

Decision record: [ADR 0001 — one instance per site](../adr/0001-one-instance-per-site.md).

> **Current live state (2026-09-11):** only **ditexpo** is provisioned on the
> VPS, living at `/opt/sites/ditexpo` (its own `compose.yml` + `.env`). The
> four-site table below is the target layout — the other sites have no
> containers, directories, or Nginx configs yet. Provision them following
> this document when needed.

---

## TL;DR

| Site | CMS admin domain (this VPS) | Public site (Cloudflare Pages) | Container | Host port | Data dirs (next to the compose file) |
|---|---|---|---|---|---|
| ditexpo | `ditexpo-cms.idcnova.com` | `ditexpo.com` | `ditexpo` | `127.0.0.1:3001` | `deploy/ditexpo/data`, `deploy/ditexpo/uploads` |
| difgc | `difgc-cms.idcnova.com` | *(per-topic domain)* | `difgc` | `127.0.0.1:3002` | `deploy/difgc/data`, `deploy/difgc/uploads` |
| site3 | *(placeholder)* `site3-cms.idcnova.com` | *(TBD)* | `site3` | `127.0.0.1:3003` | `deploy/site3/data`, `deploy/site3/uploads` |
| site4 | *(placeholder)* `site4-cms.idcnova.com` | *(TBD)* | `site4` | `127.0.0.1:3004` | `deploy/site4/data`, `deploy/site4/uploads` |

Ports bind to `127.0.0.1` only — Nginx is the sole public entry.

## Files

Each site is **its own Compose project** — its own file, its own `.env`, its
own state. Nothing is shared between sites except the Nginx vhosts and the
image registry:

```text
deploy/<site>/compose.yml             # this site's single-service stack
deploy/<site>/.env.example            # per-site env template (git-tracked)
deploy/<site>/.env                    # image tag, origin, secret (git-ignored)
deploy/<site>/data/                   # this site's SQLite database (server state)
deploy/<site>/uploads/                # this site's media + published artefacts
deploy/nginx/<site>-cms.conf          # one Nginx vhost per CMS admin domain
deploy/.env.swr                       # per-machine SWR login (git-ignored)
```

Because each directory is an independent Compose project, `up`, `down`,
`pull`, `ps`, and `logs` are per-site by construction — there is no command
that can accidentally touch another site.

## Prerequisites

1. Docker Engine + Compose plugin on the VPS.
2. Image pushed to Huawei Cloud SWR (below).
3. DNS: each `<site>-cms.idcnova.com` domain resolves via the ELB to this
   server's port **80** (HTTP). TLS certificates are managed on the ELB —
   the VPS never terminates HTTPS.
4. Nginx installed on the host with a conf include directory (e.g.
   `/etc/nginx/conf.d/*.conf`).

## Image build and SWR push

**Preferred: the release script** — works the same on Mac (ARM) and Windows
(x86); it always builds `linux/amd64`, auto-tags as `YYYYMMDD-<git short hash>`
(or takes an explicit tag), and refuses to run without Docker + an SWR login:

```sh
bun run release            # auto tag, e.g. 20260212-a1b2c3
bun run release v3         # explicit tag
```

Alternative to manual login: put the credentials in `deploy/.env.swr` (git-ignored;
copy `deploy/.env.swr.example`) — the script then runs `docker login` itself when
needed. The real file never leaves the operator's machine.

Manual equivalent:

```sh
# One-time: login to SWR (ap-southeast-3). Credentials are Huawei Cloud access
# keys — keep them OUT of this repo; the login command runs interactively on the VPS.
docker login -u ap-southeast-3@<ACCESS-KEY> -p <SECRET> swr.ap-southeast-3.myhuaweicloud.com

docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  -t swr.ap-southeast-3.myhuaweicloud.com/idcnova/instatic:v1 --push .
```

`--provenance=false --sbom=false` is required: buildx's default OCI attestation
manifests are rejected by SWR ("fail to parse 'manifest.json'").

Set the tag once in each site's `.env` (`deploy/<site>/.env` — copy from
`.env.example`):

```sh
INSTATIC_IMAGE=swr.ap-southeast-3.myhuaweicloud.com/idcnova/instatic:v1
```

## First deployment

Copy to the server (e.g. `/opt/instatic/`): the whole `deploy/` directory —
per-site compose files, `.env` files, and Nginx vhosts all live in it. Then on the server:

```sh
cd /opt/instatic
for s in ditexpo difgc site3 site4; do
  [ -f deploy/$s/.env ] || cp deploy/$s/.env.example deploy/$s/.env
done

# In each deploy/<site>/.env:
#   INSTATIC_IMAGE     — the image tag for this site
#   PUBLIC_ORIGIN      — https://<site>-cms.idcnova.com
#   INSTATIC_SECRET_KEY — unique per site (openssl rand -base64 32)

cd deploy/ditexpo && docker compose up -d && cd ../..
cd deploy/difgc  && docker compose up -d && cd ../..
```

Install the Nginx vhosts, one file per CMS domain, then reload:

```sh
sudo cp deploy/nginx/ditexpo.conf deploy/nginx/difgc.conf /etc/nginx/conf.d/
sudo nginx -t && sudo systemctl reload nginx
```

Open each `<site>-cms.idcnova.com`, complete the admin setup wizard, and create
that site's admin account. Accounts are per-site by design. GitHub publish
settings (PAT + target repository) are configured per site in the admin.

## Server layout

```text
/opt/instatic/
└── deploy/                      # everything lives in deploy/
    ├── ditexpo/                 # one Compose project per site
    │   ├── compose.yml
    │   ├── .env                 # image tag, origin, secret
    │   ├── data/cms.db          # ditexpo SQLite — visible, copy-to-backup
    │   └── uploads/…            # ditexpo media + published artefacts
    ├── difgc/
    │   ├── compose.yml
    │   ├── .env
    │   ├── data/cms.db
    │   └── uploads/…
    ├── nginx/
    └── .env.swr                  # per-machine SWR login (git-ignored)
```

The image itself is stateless — the database and media live only in these
directories. Replacing the image never touches site data.

## Upgrading (per site, never all at once)

```sh
# Build & push the new tag locally (`bun run release`), then on the VPS:
cd /opt/instatic/deploy/ditexpo
# 1. set INSTATIC_IMAGE to the new tag in .env
docker compose pull
docker compose up -d
curl -fsS http://127.0.0.1:3001/health && open https://ditexpo-cms.idcnova.com  # smoke test
# repeat per site (difgc :3002, site3 :3003, site4 :3004); each site keeps its
# own tag in its own .env, so a bad release only ever breaks the site you
# upgraded — roll that site back by pointing its INSTATIC_IMAGE back and up -d.
```

Migrations run automatically on each container's startup; process isolation
means one site's migration never touches another. Sites may sit briefly on
different tags during a graded rollout, but align them on the same tag once
verified — long-lived version skew across sites is a debugging hazard.

## Adding a new site

1. `mkdir deploy/<site>` and copy a sibling site's `compose.yml` + `.env.example`
   into it; edit the host port in `compose.yml` (next free port, 3005+).
2. `cp deploy/<site>/.env.example deploy/<site>/.env` and fill in image tag,
   `PUBLIC_ORIGIN`, and a fresh `INSTATIC_SECRET_KEY`.
3. `cp deploy/nginx/site3.conf.example /etc/nginx/conf.d/<site>-cms.conf` and
   edit `server_name` + upstream port.
4. `cd deploy/<site> && docker compose up -d && nginx -t && systemctl reload nginx`.

Register the site's local dev workspace too: add it to the port table in
`scripts/dev-site.sh` and run `scripts/dev-site.sh <site>` to seed it (see
[local-workspaces.md](local-workspaces.md)).

## Backup and restore

Each site is one plain directory (`deploy/<site>/`, with `data/` + `uploads/`
inside) — no docker commands needed:

- `deploy/<site>/data/cms.db` — use `sqlite3 cms.db ".backup '…'"` for a consistent
  snapshot, or copy while the site is idle.
- `deploy/<site>/uploads/` — media + `published/` static artefacts.

Restore = stop the container, put the files back, start it.

## Health / inspection runbook

```sh
cd /opt/instatic
for s in ditexpo:3001 difgc:3002 site3:3003 site4:3004; do
  printf "%s: " "${s%%:*}"
  curl -fsS "http://127.0.0.1:${s##*:}/health" || echo DOWN
done
```

No unified control plane is provided (deliberate — see the ADR).

## Hardening (optional)

- Rate-limit or IP-allowlist `/admin` in each Nginx vhost.
- Restrict ELB security group so only the ELB's IPs reach port 80.
