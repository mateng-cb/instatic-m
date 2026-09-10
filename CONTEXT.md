# Context

Glossary for the Insta-tite (Instatic) deployment domain. Terms only — no
implementation detail. Decisions live in `docs/adr/`.

## Glossary

**Site（站点）** — One independently-operated public website with its own
domain, content, admin accounts, and audience. A site is the unit of ownership:
nothing is shared between sites, not content, not accounts, not storage.

**CMS origin（CMS 域名）** — The admin-only domain of a Site's Instance
(`<site>-cms.idcnova.com`). Editors reach the Site here; visitors never do.
See ADR 0002.

**Public site（公开站点）** — The visitor-facing domain of a Site, served by
Cloudflare Pages from the GitHub export. Fully decoupled from the CMS origin.

**Instance（实例）** — One running Instatic process (container) serving exactly
one Site. The mapping is strictly 1:1; there is no multi-site instance.

**Site data（站点数据）** — The pair of (SQLite database file, uploads
directory) that fully captures a Site's state. Site data is self-contained:
moving a Site equals moving these two files/directories.

**Published artefacts（发布产物）** — The fully-static HTML/CSS/JS output of a
publish action, stored under the Site's uploads directory. Regenerable from
Site data; backed up for convenience, not correctness.

**Local site workspace（本地站点工作区）** — A Site's Site data on a
developer machine (one directory per Site), used as the content-authoring
place before the Site launches. Disposable: not a backup, never committed to
git, never the long-term source of truth.

**Content authority（内容事实源）** — The single place where content edits are
allowed to happen at any moment. Per Site: the Local site workspace before
launch, the production Instance after. Edits never happen in both at once, and
Site data flows one-way: workspace → production at launch, production →
workspace only as disposable debug snapshots thereafter.

**Shared image（共享镜像）** — The one Docker image (from SWR `idcnova/instatic`)
that every Site's Instance runs. Sites differ only by environment variables and
volumes, never by code.

**Per-site upgrade（逐站升级）** — The deployment discipline of restarting and
verifying one Instance at a time against a new image tag, so a bad release
affects at most one Site.

**Edge (ELB + host Nginx)** — The dispatch layer: Huawei Cloud ELB terminates
TLS, the host Nginx routes by domain to the Site's loopback port. Neither runs
application logic.

## Decisions

See `docs/adr/0001-one-instance-per-site.md` — multi-site hosting is done by
process isolation (one Instance per Site), not in-kernel multi-tenancy.

See `docs/adr/0003-single-content-authority.md` — at any moment exactly one
place edits a Site's content (the Local site workspace before launch, the
production Instance after), and Site data flows one-way, never merging.
