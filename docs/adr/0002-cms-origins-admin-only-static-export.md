# CMS origins are admin-only; public sites are static exports

The Instatic instances on the VPS serve **only the CMS admin backends**, at
`<site>-cms.idcnova.com` domains (e.g. `ditexpo-cms.idcnova.com`). They are
never the public origin of a site. Published sites go through the static
export pipeline: publish → GitHub repository → Cloudflare Pages pulls and
serves each site under its own public domain.

## Why

- The public edge (Cloudflare) is fully decoupled from the VPS: CMS downtime,
  upgrades, and migrations never affect visitors; the VPS never faces
  site traffic at all.
- Each topic site keeps an independent domain and independent deploy cadence
  on Cloudflare Pages.
- It matches the product's publishing design: Layer A bakes fully static pages
  at publish time, so a static host is the natural serving tier
  (see `docs/features/publisher.md`, `docs/deployment/github-pages.md`).

## Consequences

- `PUBLIC_ORIGIN` on each instance is the **CMS domain**
  (`https://ditexpo-cms.idcnova.com`), not the public site domain — the CMS
  origin is what the CSRF check and admin links must trust.
- Nginx on the VPS routes by `<site>-cms.idcnova.com` server names only.
- Media referenced by published pages must travel with the static export
  (see `docs/deployment/github-pages.md`); the VPS uploads volume is a CMS
  concern, not a public-serving concern.
- GitHub publish uses a PAT stored (reversibly encrypted) in each instance's
  DB — a real `INSTATIC_SECRET_KEY` per instance is required.
