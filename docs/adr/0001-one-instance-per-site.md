# One Instatic instance per site (multi-site via process isolation)

We host several independent sites (currently four, including ditexpo.com) on one
VPS from a single codebase. Instead of adding multi-tenancy to the Instatic
kernel — which is explicitly a self-hosted, single-site product — each site runs
as its own Instatic container with its own SQLite database file and uploads
directory. A host Nginx (terminating nothing; TLS ends on a Huawei Cloud ELB)
dispatches by `server_name` to `127.0.0.1:3001-300N`. Zero product code is
required; the deliverables are deployment artefacts only
(`deploy/<site>/compose.yml` per site, `deploy/nginx/<site>.conf`,
docs/deployment/multi-site.md).

## Considered Options

- **In-kernel multi-tenancy (shared DB, tenant column)** — rejected: violates the
  self-hosted single-site positioning in AGENTS.md, contaminates the data model,
  and couples site failures together.
- **WordPress Multisite or another multi-site product** — rejected: loses the
  visual editor / publish pipeline; a non-starter given the existing content.
- **One instance per site (chosen)** — process-level isolation gives the cleanest
  data separation, per-site independent upgrades and rollbacks, and per-site
  future escape hatches (a busy site can move to Postgres or another host alone).
  Costs: N processes, N admin accounts, no cross-site global search. Acceptable
  at single-digit site counts.

## Consequences

- **Each site is its own Compose project** (`deploy/<site>/compose.yml` +
  `.env` + `data/` + `uploads/`): upgrading, restarting, or tearing down one
  site is structurally incapable of touching another — no shared compose
  file, project, or image variable to get wrong. Per-site image tags also
  enable graded rollouts (upgrade one site, verify, then the rest), with the
  convention that sites align on the same tag long-term.
- Per-site data lives inside the site's own directory
  (`deploy/<site>/data`, `deploy/<site>/uploads`); backup is a plain
  directory copy.
- Upgrades are per-site: pull one SWR image tag, restart one service, smoke-test,
  continue. A bad release only ever breaks one site at a time.
- There is no unified admin or cross-site statistics; a read-only control plane
  was considered and deliberately not built — per-site `curl /health` is the runbook.
- Media is served from local disk, not Huawei OBS; the plugin media-storage
  adapter layer is the documented evolution path if media volume ever demands it.
- Migration of an existing site is a data-directory move (SQLite + uploads), not
  a DB-to-DB transfer; no built-in SQLite→PG tool exists and none is needed here.
