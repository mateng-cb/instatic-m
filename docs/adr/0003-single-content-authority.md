# Single content authority per site

At any moment, exactly one place is allowed to edit a Site's content: the
**Local site workspace** before the site launches, the production Instance
after. Site data flows one-way and never merges.

## Context

Sites are developed locally before launch: content is authored in the local
workspace (`.sites/<site>/`, one SQLite database + uploads directory per
site) while the code is being written. After launch, operations staff
maintain the site through the production Instance's visual editor.

This creates an obvious temptation: keep the local copy alive and sync
content in both directions — content in git, dev-to-prod pushes for new
content, prod-to-dev pulls for debugging. Every variant of that was
considered and rejected.

## Considered Options

- **Site data in git (per-site content repos)** — rejected: binary churn on
  SQLite files and uploads, `-wal`/`-shm` consistency hazards, admin
  credential hashes and encrypted secrets pushed into the code-hosting
  permission domain, and repositories that grow without bound.
- **Two-way content sync (dev ⇄ prod)** — rejected: two masters. Once
  operators edit in production and developers edit locally, every later sync
  is a merge of unmergeable binary state; one side always silently loses.
- **CMS bundle export/import as the regular channel** — viable, but still
  creates a second editing place whenever used routinely. Reserved for
  deliberate one-shot transfers, not a standing pipeline.
- **Single content authority (chosen)** — before launch the local workspace
  authors the content; at launch its Site data moves to production once;
  afterwards production is the only place content changes, and the local
  workspace is demoted to disposable scratch.

## Policy

- **Workspace → production: once, at launch.** A manual runbook
  (docs/deployment/local-workspaces.md) copies `.sites/<site>/` into
  `deploy/<site>/` on the VPS. Low-frequency and destructive if done wrong,
  so it is deliberately a human-follows-a-checklist operation, not a script.
- **Production → workspace: snapshots only, overwrite, never pushed back.**
  Pulling a production snapshot over a local workspace is for debugging with
  real data. The local copy has no authority, so the snapshot simply
  replaces it; nothing local is "merged back".
- **Site data is never committed to git.** Local workspaces are git-ignored
  (`.sites/`); the VPS `deploy/<site>/` directories are server state, not
  repository content. Git versions code and deployment configuration only.
- **Launch-time upload is the exception, not a pattern.** A redesign that
  re-authors a site locally may repeat the workspace → production move, but
  as an explicit cutover decision — content authored in production after the
  previous cutover is replaced wholesale, not merged.

## Consequences

- No content-sync, merge, or content-in-git tooling exists or is wanted;
  their absence is deliberate.
- Debugging with production data requires the manual snapshot-pull runbook;
  encrypted secrets in the snapshot (e.g. the GitHub publish PAT) do not
  decrypt locally — the site `INSTATIC_SECRET_KEY` never leaves the VPS, and
  only the production instance needs them.
- Local workspaces are disposable: reset with `bun run db:drop --site <name>`,
  recreate by re-seeding or by pulling a production snapshot.
- Backup of post-launch content is the production Instance's responsibility
  (docs/deployment/backup-restore.md), never the developer's laptop.
