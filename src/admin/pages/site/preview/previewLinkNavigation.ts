/**
 * previewLinkNavigation — classify link clicks inside the preview iframe.
 *
 * The preview document is server-built through the same publisher path as a
 * published page, so its in-site links are root-relative public paths
 * (`/`, `/conference`). But the iframe renders via `srcDoc`, whose document
 * inherits the admin app's URL as its base — a raw `/conference` click would
 * navigate the iframe to the admin frontend, not the site. The preview turns
 * those clicks into draft-page switches instead (the overlay stays open and
 * rebuilds the preview for the target page).
 *
 * Page lookup goes through `pagePublicPath` — the same slug→path mapping the
 * publisher emits — so nested slugs and the `index` → `/` home rule resolve
 * with one source of truth. Admin-side code must not hand-build these paths.
 */
import { pagePublicPath, type Page } from '@core/page-tree'

export type PreviewLinkAction =
  /** A root-relative path matching a page in the current draft — switch to it. */
  | { kind: 'internal'; pageId: string }
  /** A root-relative path no page answers to — dead link in the draft. */
  | { kind: 'internal-missing'; path: string }
  /** A same-document fragment (`#…`) — let the iframe scroll natively. */
  | { kind: 'anchor' }
  /** An absolute URL or other scheme — open outside the preview. */
  | { kind: 'external'; url: string }

/**
 * Classify an href for in-preview navigation.
 *
 * Returns `null` when the link needs no preview handling (`javascript:` is
 * inert under the script-less sandbox; empty hrefs navigate nowhere).
 */
export function classifyPreviewLink(href: string, pages: readonly Page[]): PreviewLinkAction | null {
  const raw = href.trim()
  if (!raw) return null
  if (raw === '#' || raw.startsWith('#')) return { kind: 'anchor' }

  // Scheme-relative (`//host/...`) and any explicit scheme (`https:`, `mailto:`, …).
  if (raw.startsWith('//')) return { kind: 'external', url: raw }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    if (raw.startsWith('javascript:')) return null
    return { kind: 'external', url: raw }
  }

  // Root-relative (or bare relative — no usable base exists inside srcDoc,
  // so treat it as a site path). Strip hash/query, normalize trailing slashes.
  const pathOnly = raw.split('#')[0]!.split('?')[0]!
  const path = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path || '/'
  const page = pages.find((p) => pagePublicPath(p.slug) === normalized)
  return page ? { kind: 'internal', pageId: page.id } : { kind: 'internal-missing', path: normalized }
}

/**
 * The clicked `<a href>` for an event inside the preview iframe, or `null`.
 * Elements from the iframe's realm fail parent-realm `instanceof` checks
 * (see `sameOriginDocuments.isNode` for the same constraint), so this
 * duck-types on `closest`.
 */
export function anchorForClickTarget(target: EventTarget | null): Element | null {
  if (target == null || typeof (target as { closest?: unknown }).closest !== 'function') return null
  return (target as Element).closest('a[href]')
}
