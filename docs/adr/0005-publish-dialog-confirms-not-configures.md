# 0005 — GitHub publish dialog confirms, it does not configure

## Status

Accepted

## Context

The "Publish to GitHub…" entry in the site editor's Publish menu opened a
dialog that duplicated the Settings → Publishing configuration form: repo
URL, branch, target directory, base path, commit message, and personal
access token were all editable there, and the dialog re-saved the settings
before starting the push. Two configuration surfaces for one feature meant
two places to keep mentally in sync, and a heavyweight modal standing
between the operator and a one-click publish they had already configured.

The publish itself is a minutes-long background job, so some dialog surface
is still needed — for confirmation before the run and for progress during
it.

## Decision

Configuration lives **only** in Settings → Publishing. The publish dialog is
a confirm-and-track surface:

- The confirm view shows the stored repo / branch / token status read-only.
  When the repository or token is unconfigured, Publish is replaced by a
  jump to Settings → Publishing.
- Publish starts the job with the stored settings — no body overrides, the
  dialog saves nothing. The per-publish commit message field was removed;
  every commit uses the server default. (The server retains its optional
  override parameters untouched; clients simply never send them.)
- After the job starts, the dialog switches to a read-only progress view.
  It may be closed mid-run: the job continues server-side, the outcome
  arrives via toast, and reopening the dialog adopts the running job.
- Opening the dialog while a job is already running skips the confirm view
  and shows live progress.

## Consequences

- One source of truth for GitHub publish configuration; the editor publish
  flow is one confirm click away.
- Per-publish commit messages are no longer possible from the UI. Operators
  who need custom messages can push manually from the persistent workdir.
- Server API unchanged (`POST /publish-github` keeps its optional override
  fields); only the client stopped sending them.
