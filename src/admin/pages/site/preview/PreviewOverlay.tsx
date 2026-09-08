/**
 * PreviewOverlay — full-screen in-browser preview of the current draft page.
 *
 * Builds the active in-memory draft through the authenticated runtime-preview
 * endpoint, then renders the result into a sandboxed <iframe>. The server path
 * owns request-time concerns such as loop and media prefetch, keeping Preview
 * aligned with the public renderer without publishing the draft.
 *
 * Accessibility (Guideline #225 / WCAG 2.1 AA):
 * - role="dialog" + aria-modal="true"
 * - Focus trapped: close button receives focus on open, returned on close
 * - Esc closes the overlay
 * - Backdrop click closes the overlay
 *
 * Security:
 * - iframe uses sandbox="allow-same-origin allow-popups" — no allow-scripts,
 *   so the preview document itself stays script-less (its own CSP meta tag
 *   also pins script-src 'none'). allow-same-origin only lets the parent
 *   reach the document to re-route link clicks; allow-popups lets
 *   target=_blank external links open a new tab.
 *
 * In-preview navigation:
 * - Clicking an in-site permalink switches the preview to that draft page
 *   (openPageInCanvas) instead of navigating the iframe — srcDoc documents
 *   inherit the admin app URL as base, so a raw "/" would land in the admin
 *   frontend. External links open in a new tab; dead in-site links toast.
 *   See previewLinkNavigation.ts.
 *
 * data-testid="preview-overlay" and data-testid="preview-iframe" for Playwright
 */

import { useEffect, useRef } from 'react'
import type { Page, SiteDocument } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { useEditorStore, selectActivePage } from '@site/store/store'
import { useTemplatePreviewContext } from '@site/hooks/useTemplatePreviewContext'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { pushToast } from '@ui/components/Toast'
import { useRuntimePreviewDocument } from './useRuntimePreviewDocument'
import { anchorForClickTarget, classifyPreviewLink } from './previewLinkNavigation'
import styles from './PreviewOverlay.module.css'

interface PreviewDocumentProps {
  site: SiteDocument
  page: Page
  templatePreviewContext: TemplateRenderDataContext | undefined
}

function PreviewDocument({ site, page, templatePreviewContext }: PreviewDocumentProps) {
  const reportedErrorRef = useRef<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const openPageInCanvas = useEditorStore((s) => s.openPageInCanvas)
  const { html, loading, error, refresh } = useRuntimePreviewDocument(
    site,
    page,
    templatePreviewContext,
  )

  // ── In-preview link navigation ──────────────────────────────────────────
  // Re-routes clicks on in-site permalinks to draft-page switches. Attached
  // per preview document: re-runs whenever the server rebuild swaps the
  // srcDoc (page switch, draft edit, refresh).
  useEffect(() => {
    if (!html) return
    const iframe = iframeRef.current
    if (!iframe) return
    const handleLinkClick = (event: Event) => {
      const anchor = anchorForClickTarget(event.target)
      if (!anchor) return
      // Read the site at click time — the listener outlives the render that
      // attached it, and co-edits can change the page list meanwhile.
      const pages = useEditorStore.getState().site?.pages
      if (!pages) return
      const action = classifyPreviewLink(anchor.getAttribute('href') ?? '', pages)
      if (!action) return
      if (action.kind === 'internal') {
        event.preventDefault()
        openPageInCanvas(action.pageId)
        return
      }
      if (action.kind === 'internal-missing') {
        event.preventDefault()
        pushToast({
          kind: 'info',
          title: 'No page at this address',
          body: `The draft has no page at "${action.path}" — the link may be stale.`,
          location: 'preview-overlay',
        })
        return
      }
      if (action.kind === 'external') {
        // Targets that already escape the iframe go through the browser
        // (allow-popups); a bare external link would otherwise navigate the
        // preview frame itself, so re-route it to a new tab.
        const linkTarget = anchor.getAttribute('target') ?? ''
        if (linkTarget === '_blank' || linkTarget === '_parent' || linkTarget === '_top') return
        event.preventDefault()
        window.open(action.url, '_blank', 'noopener')
      }
    }
    const attach = () => {
      iframe.contentDocument?.addEventListener('click', handleLinkClick, true)
    }
    // srcDoc documents usually parse before effects run; the load event
    // covers the deferred case. addEventListener dedupes an identical
    // (function, capture) registration, so double-attaching is harmless.
    attach()
    iframe.addEventListener('load', attach)
    return () => {
      iframe.removeEventListener('load', attach)
      iframe.contentDocument?.removeEventListener('click', handleLinkClick, true)
    }
  }, [html, openPageInCanvas])

  useEffect(() => {
    if (!error) {
      reportedErrorRef.current = null
      return
    }
    if (reportedErrorRef.current === error) return
    reportedErrorRef.current = error
    pushToast({
      kind: 'error',
      title: "Couldn't build preview",
      body: error,
      location: 'preview-overlay',
    })
  }, [error])

  if (error) {
    return (
      <EmptyState
        variant="centered"
        title="Preview unavailable"
        description={error}
        action={<Button variant="secondary" onClick={refresh}>Retry preview</Button>}
        role="alert"
        data-testid="preview-error"
      />
    )
  }

  if (loading || !html) {
    return (
      <EmptyState
        variant="centered"
        title="Building preview…"
        description="Resolving dynamic content and page assets."
        data-testid="preview-loading"
      />
    )
  }

  return (
    <iframe
      ref={iframeRef}
      srcDoc={html}
      sandbox="allow-same-origin allow-popups"
      title={`Preview: ${page.title}`}
      data-testid="preview-iframe"
      className={styles.iframe}
    />
  )
}

export function PreviewOverlay() {
  const open = useEditorStore((s) => s.previewOpen)
  const closePreview = useEditorStore((s) => s.closePreview)
  const site = useEditorStore((s) => s.site)
  const activePage = useEditorStore(selectActivePage)
  const { context: templatePreviewContext } = useTemplatePreviewContext(activePage)

  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  // Focus management
  useEffect(() => {
    if (open) {
      if (document.activeElement instanceof HTMLElement) {
        triggerRef.current = document.activeElement
      }
      requestAnimationFrame(() => closeBtnRef.current?.focus())
    } else {
      triggerRef.current?.focus()
      triggerRef.current = null
    }
  }, [open])

  // Esc closes the overlay
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePreview()
    }
  }

  if (!open || !site || !activePage) return null

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={closePreview}
        className={styles.backdrop}
      />

      {/* Dialog wrapper */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Page preview"
        data-testid="preview-overlay"
        onKeyDown={handleKeyDown}
        className={styles.dialogWrapper}
      >
        {/* Inner card */}
        <div className={styles.card}>
          {/* ── Header bar ──────────────────────────────────────────────── */}
          <div className={styles.header}>
            <EyeSolidIcon size={14} color="var(--text-muted)" className={styles.headerIcon} />
            <span className={styles.headerTitle}>
              Preview — {activePage.title}
            </span>

            {/* Close button */}
            <Button
              ref={closeBtnRef}
              variant="ghost"
              size="lg"
              onClick={closePreview}
              aria-label="Close preview"
            >
              <CloseIcon size={12} color="currentColor" aria-hidden="true" />
              Close
            </Button>
          </div>

          {/* ── Sandboxed server-built preview ─────────────────────────── */}
          <div className={styles.previewContent}>
            <PreviewDocument
              site={site}
              page={activePage}
              templatePreviewContext={templatePreviewContext}
            />
          </div>
        </div>
      </div>
    </>
  )
}
