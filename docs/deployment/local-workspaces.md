# Local Site Workspaces (multi-site development)

Several sites are developed on one machine from one checkout. Each site's
local **Site data** (SQLite database + uploads directory — see the glossary in
[`CONTEXT.md`](../../CONTEXT.md)) lives in its own workspace directory, and
one dev server runs per site you are actively working on.

Decision records: [ADR 0003 — single content authority](../adr/0003-single-content-authority.md)
(who may edit content, and which way Site data flows), built on
[ADR 0001 — one instance per site](../adr/0001-one-instance-per-site.md).

---

## Layout

```text
instatic-dite/                 # one code checkout serves all sites
└── .sites/                    # git-ignored — disposable, never committed
    ├── ditexpo/
    │   ├── data/cms.db        # the site's SQLite database
    │   └── uploads/           # media, fonts, published artefacts
    ├── difgc/
    ├── site3/
    └── site4/
```

Workspaces are **not backups and not source**. They are scratch copies of a
Site's data. Deleting one loses nothing that production doesn't own (after
launch) or that isn't cheap to re-seed (before launch).

## Running a site locally

```sh
scripts/dev-site.sh ditexpo     # http://127.0.0.1:3001
scripts/dev-site.sh difgc       # http://127.0.0.1:3002 — can run side by side
scripts/dev-site.sh --list
```

The script sets `DATABASE_URL` and `UPLOADS_DIR` to the site's workspace and
mirrors the production port mapping (ditexpo=3001 … site4=3004). The first
run creates empty directories; the server seeds the database and you walk the
setup wizard — the workspace then becomes the place where that site's content
is authored.

Reset one site's workspace and start over:

```sh
bun run db:drop --site ditexpo
```

## Content flows — one authority, one direction

See ADR 0003 for the reasoning. In short:

- **Before launch** the local workspace is the content authority: you author
  the site's content in the local visual editor.
- **At launch** the workspace's Site data moves to the server once (below).
- **After launch** the production Instance is the authority — operators edit
  in the production admin. The local workspace is never pushed again, and
  local edits to a launched site's content have no effect on production.

## Uploading a workspace to production (launch)

Low-frequency and destructive if done wrong — do it by hand, following the
checklist, from the repo root on your machine (adjust `user@vps:/opt/instatic`):

1. Stop the target site's container on the VPS:
   `ssh vps "cd /opt/instatic/deploy/<site> && docker compose stop"`
2. Make a safety copy of what's there now (even when it's an empty skeleton):
   `ssh vps "cp -a /opt/instatic/deploy/<site>/data /opt/instatic/deploy/<site>/data.bak-$(date +%F)"`
3. Snapshot the local database for a consistent copy (the dev server must be
   stopped, or use `sqlite3`):
   ```sh
   sqlite3 .sites/<site>/data/cms.db ".backup '.sites/<site>/data/cms.db.upload'"
   ```
4. Upload both halves of the Site data:
   ```sh
   scp .sites/<site>/data/cms.db.upload vps:/opt/instatic/deploy/<site>/data/cms.db
   rm .sites/<site>/data/cms.db.upload
   rsync -a --delete .sites/<site>/uploads/ vps:/opt/instatic/deploy/<site>/uploads/
   ```
5. Start the container and smoke-test; migrations run on startup:
   ```sh
   ssh vps "cd /opt/instatic/deploy/<site> && docker compose up -d"
   curl -fsS http://127.0.0.1:3001/health   # from the VPS
   ```
6. From this point the local workspace is stale by definition. Delete it, or
   keep it only to overwrite with a production snapshot (below).

## Pulling a production snapshot for debugging (manual, overwrite)

Production is the authority; the local copy is just overwritten:

1. Consistent snapshot on the VPS, then transfer both halves:
   ```sh
   ssh vps "sqlite3 /opt/instatic/deploy/<site>/data/cms.db \".backup '/tmp/<site>.db'\""
   scp vps:/tmp/<site>.db .sites/<site>/data/cms.db
   ssh vps "cd /opt/instatic/deploy/<site> && tar czf /tmp/<site>-uploads.tgz -C uploads ."
   rsync -a --delete vps:/opt/instatic/deploy/<site>/uploads/ .sites/<site>/uploads/   # or untar the tgz
   ssh vps "rm /tmp/<site>.db /tmp/<site>-uploads.tgz"
   ```
2. `scripts/dev-site.sh <site>` and log in with **production credentials**
   (the snapshot carries the production user table).
3. Encrypted secrets (e.g. the site's GitHub publish PAT) do **not** decrypt
   locally — they are keyed to the production `INSTATIC_SECRET_KEY`, which
   deliberately never leaves the VPS. Everything else works normally.

## What lives in git

Only code and deployment **configuration**: `deploy/<site>/compose.yml`,
`deploy/<site>/.env.example`, Nginx vhosts, docs. Real `.env` files and
`.sites/` are git-ignored. Site data (databases, media) never enters git —
see ADR 0003 for why.
