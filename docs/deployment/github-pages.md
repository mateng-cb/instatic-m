# GitHub Pages Deployment

This guide covers publishing an Instatic site to GitHub Pages: prerequisites, PAT scopes, branch layout, `basePath`, and where settings live in the admin UI.

GitHub Pages is a **static host**. Instatic does not run the Bun server on Pages — it exports the already-published snapshot with `pathMode: 'basePath'`, then pushes the file tree to a GitHub branch via the Git Data API. Local Publish (Layer A) must succeed before any export or GitHub push.

---

## TL;DR

| Step | Action |
|---|---|
| 1 | Publish the site locally in the Site editor (Layer A snapshot in `uploads/published/current/`) |
| 2 | Create the target branch on GitHub (e.g. empty `gh-pages`) — Instatic **does not** auto-create it |
| 3 | Set `INSTATIC_SECRET_KEY` on the server so the PAT can be encrypted at rest |
| 4 | Configure repo URL, branch, `targetDir`, `basePath`, and PAT under **Settings → Publishing** (or in the Publish dialog) |
| 5 | Enable GitHub Pages: **Deploy from a branch**, branch = your target, folder = `/` or `/docs` |
| 6 | **Publish → Publish to GitHub…** — starts the export + push as a background job (step-up gated); the dialog polls live progress until the commit lands |

| Site type | Typical URL | `basePath` |
|---|---|---|
| user/org Pages | `https://user.github.io/` | `""` |
| project Pages | `https://user.github.io/my-repo/` | `/my-repo` |
| custom domain (apex) | `https://www.example.com/` | `""` |

---

## Prerequisites

### Local Publish first

GitHub publish reads the same published slot as static export. If the site has never been published, the background job fails with `failure.code: not-published` (`Site has not been published yet.`) — the start endpoint still answers **202**; the dialog surfaces the failure while polling.

Workflow:

```text
Site editor → Publish          (Layer A bake to uploads/published/current/)
           → Publish to GitHub… (export with pathMode: basePath → Git Data API push)
```

Export static site (ZIP) is optional — it uses the same Phase A pipeline but defaults to `pathMode: 'relative'`. GitHub push always uses `pathMode: 'basePath'` with the configured `basePath`. See [docs/features/publisher.md](../features/publisher.md) → Static export (Phase A) and GitHub publish (Phase B).

### `INSTATIC_SECRET_KEY`

The GitHub PAT is stored encrypted in `github_publish_settings` (`server/repositories/githubPublishSettings.ts`), using the same `encryptSecret` / `decryptSecret` path as AI provider keys and MFA seeds.

- Generate: `bun run scripts/generate-secret-key.ts`
- Set on the server before saving a PAT in admin
- Without it, PUT settings fails with a master-key configuration error (same as other reversible secrets)

The API never returns plaintext token, ciphertext, or IV — only `hasToken` and `keyFingerprintCurrent` on the wire view.

### Personal access token (PAT)

Create a PAT on GitHub with write access to repository contents:

| Token type | Required scope |
|---|---|
| Classic PAT | `repo` scope, or minimum **`contents: write`** on the target repo |
| Fine-grained PAT | Repository access to the target repo; **Contents: Read and write** |

Instatic uses the Git Data API (`server/github/gitDataApiPush.ts`) — no local `git` binary. Blobs upload 4 at a time with a 60 s per-request timeout; the token is sent only to `api.github.com` during push; it is not written to logs or the export tree. The push runs as a **background job** (a full-site push takes minutes — longer than reverse-proxy timeouts such as Cloudflare's ~100 s synchronous limit), and the publish dialog polls `GET /admin/api/cms/github-publish/progress` (1 s interval) for per-file upload progress (`Uploading files 45/132 — path`) and the final outcome.

Every push writes a root **`.nojekyll`** marker into the target tree. GitHub Pages runs Jekyll by default and Jekyll silently drops `_`-prefixed paths — all Instatic assets live under `_instatic/`, so without the marker every stylesheet and runtime script would 404 on Pages.

**Token rotation in admin:** omit `token` on PUT → keep existing; empty string → clear; non-empty string → replace.

---

## GitHub repository setup

### Create the target branch

Instatic **does not** create branches. If the configured branch (default `gh-pages`) does not exist, push fails with:

```txt
Branch does not exist: <branch>. Create the branch on GitHub before publishing.
```

Create the branch before the first push:

1. On GitHub: create an orphan branch (e.g. `gh-pages`) with an initial empty commit, **or**
2. Push an empty tree from another tool, **or**
3. Use an existing branch (e.g. `main`) and set that name in Instatic settings

### Enable GitHub Pages

In the repository **Settings → Pages**:

| Setting | Value |
|---|---|
| Source | Deploy from a branch |
| Branch | Same as Instatic **Branch** field (default `gh-pages`) |
| Folder | `/` when **Target directory** in Instatic is empty; `/docs` when **Target directory** is `docs` |

Instatic does **not** call the Pages enable API — enable Pages manually after the first successful push.

Custom domains: configure in GitHub Pages settings; use `basePath: ""` when the site is served at the domain apex (see table above).

---

## Admin configuration

Two entry points share the same persisted row (`github_publish_settings`, singleton `id = 'default'`):

| Location | Purpose |
|---|---|
| **Settings → Publishing** → GitHub Pages block | Save defaults and PAT (`putGithubPublishSettings`). Does not push. |
| **Site editor → Publish menu → Publish to GitHub…** | `GithubPublishDialog` — loads settings, saves on submit, starts the push job, polls until it settles (adopting an already-running job if the dialog opens mid-push) |

Fields:

| Field | Meaning |
|---|---|
| Repository URL | e.g. `https://github.com/owner/repo` — parsed by `server/github/parseRepoUrl.ts` |
| Branch | Ref to update (default `gh-pages`) |
| Target directory | Subtree under branch root; empty = replace entire branch tree; `docs` = push under `docs/` |
| Base path | URL prefix for asset rewrite — `/my-repo` for project Pages, empty for user/org or apex custom domain |
| PAT | Encrypted at rest; shown as “Token saved” when present |

Push requires capability `pages.publish` plus step-up (same blast radius as local Publish and static export ZIP).

---

## Push semantics

```text
publishSiteToGithub (server/publish/githubPublish.ts)
  ├─► exportPublishedSiteStatic({ pathMode: 'basePath', basePath })
  └─► gitDataApiPush({ owner, repo, branch, targetDir, exportDir })
        blobs → tree → commit → update ref
```

| `targetDir` | Effect on branch |
|---|---|
| `""` | New commit tree is **only** the export files (full tip replace) |
| `docs` (example) | Removes prior paths under `docs/`, keeps sibling paths, writes export under `docs/` |

Media in the export includes **only files referenced by published pages** after URL rewrite — not the full uploads library. See Phase A export rules in [docs/features/publisher.md](../features/publisher.md).

---

## Size and API limits

Soft guidance for operators:

- Export packs referenced media only, but large sites (many high-resolution assets, long runtime bundles) can still produce a heavy tree.
- Each file is uploaded as a Git blob; **single files over 100 MB** fail with a clear error (no Git LFS in phase B).
- GitHub rate-limits the REST API; `gitDataApiPush` retries **429** and **5xx** responses up to three times.
- Very large repositories may hit GitHub’s recursive tree size limits during subtree replace — push fails with an explicit truncation error.

If push fails after a successful export, the server keeps the temp export directory for inspection/retry; successful push deletes it.

---

## HTTP API (operator reference)

| Method | Path | Auth |
|---|---|---|
| `GET` | `/admin/api/cms/github-publish/settings` | `pages.publish` |
| `PUT` | `/admin/api/cms/github-publish/settings` | `pages.publish` |
| `GET` | `/admin/api/cms/github-publish/progress` | `pages.publish` |
| `POST` | `/admin/api/cms/publish-github` | `pages.publish` + step-up |

Handler: `server/handlers/cms/githubPublish.ts`. Client helpers: `src/core/persistence/cmsGithubPublish.ts`.

`POST /publish-github` starts the job and answers **202** `{ started: true }` immediately — the push itself runs in the background and its outcome arrives on the progress endpoint (`job.state: 'succeeded'` with `result: { commitSha, repoUrl, branch, report }`, or `'failed'` with `failure`).

| Status | Cause |
|---|---|
| `202` | Job started — poll the progress endpoint for the outcome |
| `409` | A GitHub publish job is already running (single slot) |

Job `failure.code` values (surfaced by the dialog as the failure message):

| Code | Cause |
|---|---|
| `not-published` | Site not published locally |
| `per-visitor-hole` | Per-visitor dynamic hole — same as static export |
| `token-missing` / `config-incomplete` | Missing token or incomplete repo config |
| `push-failed` | GitHub push failed (export dir kept on server) |
| `internal` | Unexpected server error |

---

## Out of scope (phase B)

- GitHub App installation tokens
- Non-GitHub hosts (GitLab, Codeberg, …)
- Auto-enable Pages via GitHub API
- Local `git` CLI on the server

---

## Related

- [docs/features/publisher.md](../features/publisher.md) — Publish pipeline, static export (Phase A), GitHub publish (Phase B)
- [docs/deployment/README.md](README.md) — deployment index and `INSTATIC_SECRET_KEY`
- Source-of-truth files:
  - `server/publish/githubPublish.ts` — orchestrator
  - `server/publish/githubPublishJob.ts` + `githubPublishJobRegistry.ts` — background job runner + single-slot registry
  - `server/github/gitDataApiPush.ts` — Git Data API push
  - `server/repositories/githubPublishSettings.ts` — settings + PAT encryption
  - `server/handlers/cms/githubPublish.ts` — HTTP routes
  - `src/admin/modals/GithubPublishDialog/GithubPublishDialog.tsx` — push dialog
  - `src/admin/modals/Settings/sections/PublishingSection.tsx` — settings block
- Tests: `src/__tests__/server/githubPublishOrchestrator.test.ts`, `src/__tests__/server/githubGitDataApiPush.test.ts`, `src/__tests__/server/githubPublishSettings.test.ts`, `src/__tests__/server/githubPublishJobRegistry.test.ts`, `src/__tests__/server/cmsGithubPublish.test.ts`
