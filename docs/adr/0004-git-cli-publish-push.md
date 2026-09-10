# 0004 — GitHub publish pushes via the git CLI, not the REST API

## Status

Accepted

## Context

Phase B of the publish pipeline ships the Phase A static export to a GitHub
repository, which Cloudflare Pages then serves (see
[ADR-0002](0002-cms-origins-admin-only-static-export.md)). The first
implementation pushed through GitHub's REST Git Data API: one
`POST /git/blobs` per file, then tree → commit → ref update.

That design had a structural cost: every publish re-uploaded **every file**
as an individual REST request. The authenticated REST quota is 5,000
requests/hour, so a site with a few hundred files burned a meaningful slice
of the quota per publish, unchanged media included, and large sites could
not publish at all near the limit. The retry semantics of non-idempotent
API steps (commit/ref update) also produced false failures — a job reported
FAILED while the commit had actually landed.

## Decision

Push with the **real git CLI** over HTTPS:

- One persistent **working clone** per instance (path: `workdir` setting,
  default beside the uploads volume; bind-mountable to the host so
  operators can inspect or manually push from the VPS).
- Each publish: sync the export into the worktree → one commit → `git push`.
  Git negotiates an incremental pack — only changed objects travel, and no
  REST quota applies.
- **Self-healing**: any git failure (stale `index.lock`, rejected
  non-fast-forward, corrupted clone, repo/branch switch in settings) wipes
  the clone and replays the push once from a fresh clone. A second failure
  is the reported push error.
- The PAT authenticates the **push URL only** — the clone runs from the
  neutral URL so the PAT is never written to `.git/config`; it is scrubbed
  from all git error output and never logged or written to the export tree.
- Every sync writes a root `.nojekyll` marker so GitHub Pages serves
  `_`-prefixed assets (the `_instatic/` hole fragments) without Jekyll.

The REST push implementation (`gitDataApiPush.ts`) was deleted, not kept as
a fallback — two push paths would double the failure surface for no benefit
(the git path handles everything the API path did, including branch-missing
detection and `targetDir` subtree scoping).

## Consequences

- The runtime image must ship `git` (the `oven/bun` base image does not).
- Publishes no longer consume the REST quota; frequency is bounded only by
  GitHub's push processing.
- An unchanged export produces **no empty commit** — the existing tip is
  reported instead.
- Progress reporting granularity is per copied file (worktree sync), not
  per network upload; the wire progress shape is unchanged.
- Operators who map the workdir volume get push history and can intervene
  manually (inspect, revert, push) without touching the CMS.
