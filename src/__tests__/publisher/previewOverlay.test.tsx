/**
 * Preview Overlay — Integration & Source-Scan Tests (Phase 7 / J15)
 *
 * ─── Test groups ────────────────────────────────────────────────────────────
 *   1. uiSlice preview actions — openPreview / closePreview store contract
 *   2. PreviewOverlay DOM — renders dialog, iframe, close behaviours
 *   3. PreviewOverlay source — sandbox attr, WCAG focus-return pattern
 *   4. Happy-path golden: 2-node tree → expected HTML (Phase 7 requirement)
 *   5. In-preview link navigation — clicks re-routed to draft-page switches
 *
 * Group 3 uses readFileSync source scanning (same pattern as toolbar.test.ts).
 * Groups 1–2 and 5 use @testing-library/react DOM integration (same as settingsModal.test.tsx).
 * Link routing classification itself is unit-tested in
 * src/__tests__/preview/previewLinkNavigation.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import React from 'react'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { readFileSync } from 'fs'
import { PreviewOverlay } from '@site/preview/PreviewOverlay'
import { useEditorStore } from '@site/store/store'
import { subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { publishPage } from '@core/publisher'
import { makeModule, makeRegistry, makePage, makeSite } from './helpers'

// ---------------------------------------------------------------------------
// Store reset
// ---------------------------------------------------------------------------

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    isSettingsOpen: false,
    activeSection: 'pages',
    previewOpen: false,
    hasUnsavedChanges: false,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

/** Open the preview with a simple one-page site loaded in the store. */
function openPreviewWithSite() {
  const page = {
    id: 'page-1',
    slug: 'index',
    title: 'Home',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.body',
        props: {},
        children: ['h1'],
        breakpointOverrides: {},
        locked: false,
        hidden: false,
      },
      h1: {
        id: 'h1',
        moduleId: 'base.text',
        props: { text: 'Welcome', level: 1 },
        children: [],
        breakpointOverrides: {},
        locked: false,
        hidden: false,
      },
    },
  }
  const site = makeSite({ name: 'Test Site', pages: [page] })
  useEditorStore.setState({
    site,
    activePageId: 'page-1',
    previewOpen: true,
  } as Parameters<typeof useEditorStore.setState>[0])
}

const originalFetch = globalThis.fetch
const runtimePreviewCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
let runtimePreviewHtml = '<!DOCTYPE html><html><head><title>Test Site</title></head><body><h1>Welcome</h1></body></html>'

beforeEach(() => {
  resetStore()
  runtimePreviewCalls.length = 0
  runtimePreviewHtml = '<!DOCTYPE html><html><head><title>Test Site</title></head><body><h1>Welcome</h1></body></html>'
  globalThis.fetch = async (input, init) => {
    runtimePreviewCalls.push({ input, init })
    return new Response(JSON.stringify({
      html: runtimePreviewHtml,
      assets: [],
      runtimeAssets: { scripts: [] },
      diagnostics: [],
    }), { status: 200 })
  }
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// 1 — uiSlice preview actions
// ---------------------------------------------------------------------------

describe('uiSlice — preview state', () => {
  it('previewOpen defaults to false', () => {
    expect(useEditorStore.getState().previewOpen).toBe(false)
  })

  it('openPreview() sets previewOpen to true', () => {
    useEditorStore.getState().openPreview()
    expect(useEditorStore.getState().previewOpen).toBe(true)
  })

  it('closePreview() sets previewOpen to false', () => {
    useEditorStore.getState().openPreview()
    useEditorStore.getState().closePreview()
    expect(useEditorStore.getState().previewOpen).toBe(false)
  })

  it('openPreview and closePreview are defined as functions', () => {
    const state = useEditorStore.getState()
    expect(typeof state.openPreview).toBe('function')
    expect(typeof state.closePreview).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// 2 — PreviewOverlay DOM integration
// ---------------------------------------------------------------------------

describe('PreviewOverlay — DOM rendering', () => {
  it('renders nothing when previewOpen is false', async () => {
    render(<PreviewOverlay />)
    expect(document.querySelector('[data-testid="preview-overlay"]')).toBeNull()
    expect(document.querySelector('[data-testid="preview-iframe"]')).toBeNull()
    await act(async () => {})
  })

  it('renders nothing when previewOpen=true but no site is loaded', async () => {
    useEditorStore.setState({ previewOpen: true } as Parameters<typeof useEditorStore.setState>[0])
    render(<PreviewOverlay />)
    expect(document.querySelector('[data-testid="preview-overlay"]')).toBeNull()
    await act(async () => {})
  })

  it('renders the dialog overlay when previewOpen=true with a site', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    expect(document.querySelector('[data-testid="preview-overlay"]')).not.toBeNull()
    await screen.findByTestId('preview-iframe')
  })

  it('overlay has role="dialog" and aria-modal="true"', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeDefined()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    await screen.findByTestId('preview-iframe')
  })

  it('renders the preview iframe inside the dialog', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    const iframe = await screen.findByTestId('preview-iframe')
    expect(iframe).not.toBeNull()
  })

  it('iframe has a non-empty srcdoc attribute', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    const iframe = await screen.findByTestId('preview-iframe')
    const srcdoc = iframe.getAttribute('srcdoc') ?? ''
    expect(srcdoc.length).toBeGreaterThan(0)
    expect(srcdoc).toContain('<!DOCTYPE html>')
  })

  it('iframe srcdoc contains the page title', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    const iframe = await screen.findByTestId('preview-iframe')
    const srcdoc = iframe.getAttribute('srcdoc') ?? ''
    // The site name "Test Site" should appear as the page title
    expect(srcdoc).toMatch(/<title>[^<]*<\/title>/)
  })

  it('renders server-resolved loop content from the current draft (ISS-234)', async () => {
    runtimePreviewHtml = '<!DOCTYPE html><html><body><p>ISS-234 LOOP ROW</p></body></html>'
    openPreviewWithSite()
    const currentSite = useEditorStore.getState().site
    render(<PreviewOverlay />)

    const iframe = await screen.findByTestId('preview-iframe')
    expect(iframe.getAttribute('srcdoc')).toContain('ISS-234 LOOP ROW')
    expect(runtimePreviewCalls).toHaveLength(1)
    expect(runtimePreviewCalls[0]?.input).toBe('/admin/api/cms/runtime/preview')
    expect(JSON.parse(String(runtimePreviewCalls[0]?.init?.body))).toMatchObject({
      site: currentSite,
      pageId: 'page-1',
    })
  })

  it('close button has aria-label="Close preview"', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    const closeBtn = screen.getByLabelText('Close preview')
    expect(closeBtn).toBeDefined()
    await screen.findByTestId('preview-iframe')
  })

  it('clicking the close button closes the overlay (sets previewOpen=false)', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    await screen.findByTestId('preview-iframe')
    const closeBtn = screen.getByLabelText('Close preview')
    fireEvent.click(closeBtn)
    expect(useEditorStore.getState().previewOpen).toBe(false)
  })

  it('pressing Escape closes the overlay', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    await screen.findByTestId('preview-iframe')
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' })
    expect(useEditorStore.getState().previewOpen).toBe(false)
  })

  it('clicking the backdrop closes the overlay', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    await screen.findByTestId('preview-iframe')
    // Backdrop is the first aria-hidden element
    const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement | null
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop!)
    expect(useEditorStore.getState().previewOpen).toBe(false)
  })

  it('overlay header shows page title', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    // Header reads "Preview — {page.title}"
    expect(document.body.textContent).toContain('Preview — Home')
    await screen.findByTestId('preview-iframe')
  })
})

// ---------------------------------------------------------------------------
// 3 — In-preview link navigation (DOM integration)
// ---------------------------------------------------------------------------
//
// The preview iframe renders via srcDoc, so in-site permalinks can never
// navigate normally (the document base is the admin app). A capture-phase
// click bridge re-routes them: in-site links switch the draft page, dead
// links toast, external links open a new tab, anchors stay native.

describe('PreviewOverlay — in-preview link navigation', () => {
  /** Open the preview on an index page + a /conference page, with `bodyHtml` as the preview document. */
  function openPreviewWithLinks(bodyHtml: string) {
    runtimePreviewHtml = `<!DOCTYPE html><html><head><title>Test Site</title></head><body>${bodyHtml}</body></html>`
    const home = {
      id: 'page-1',
      slug: 'index',
      title: 'Home',
      rootNodeId: 'root',
      nodes: {
        root: {
          id: 'root', moduleId: 'base.body', props: {}, children: [],
          breakpointOverrides: {}, locked: false, hidden: false,
        },
      },
    }
    const conference = {
      id: 'page-2',
      slug: 'conference',
      title: 'Conference',
      rootNodeId: 'root',
      nodes: {
        root: {
          id: 'root', moduleId: 'base.body', props: {}, children: [],
          breakpointOverrides: {}, locked: false, hidden: false,
        },
      },
    }
    const site = makeSite({ name: 'Test Site', pages: [home, conference] })
    useEditorStore.setState({
      site,
      activePageId: 'page-1',
      previewOpen: true,
    } as Parameters<typeof useEditorStore.setState>[0])
  }

  /** Wait for the preview iframe, then dispatch a click on `selector` inside it. */
  async function clickInPreview(selector: string): Promise<{ anchor: Element; defaultPrevented: boolean }> {
    const iframeEl = await screen.findByTestId('preview-iframe')
    const iframe = iframeEl as HTMLIFrameElement
    expect(iframe.contentDocument).toBeTruthy()
    const anchor = iframe.contentDocument!.querySelector(selector)
    expect(anchor).toBeTruthy()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor!.dispatchEvent(event)
    return { anchor: anchor!, defaultPrevented: event.defaultPrevented }
  }

  it('switches to the target draft page on an in-site permalink click', async () => {
    openPreviewWithLinks('<a href="/conference" id="conf-link">Conference</a>')
    render(<PreviewOverlay />)
    const { defaultPrevented } = await clickInPreview('#conf-link')
    expect(defaultPrevented).toBe(true)
    expect(useEditorStore.getState().activePageId).toBe('page-2')
    // The overlay stays open — the preview rebuilds for the new page.
    expect(useEditorStore.getState().previewOpen).toBe(true)
  })

  it('toasts on dead in-site links instead of navigating', async () => {
    const toasts: Toast[] = []
    const unsubscribe = subscribeToasts((snapshot) => { toasts.splice(0, toasts.length, ...snapshot) })

    openPreviewWithLinks('<a href="/nope" id="dead-link">Nowhere</a>')
    render(<PreviewOverlay />)
    const { defaultPrevented } = await clickInPreview('#dead-link')
    expect(defaultPrevented).toBe(true)
    expect(useEditorStore.getState().activePageId).toBe('page-1')
    expect(toasts.some((t) => t.kind === 'info' && t.title === 'No page at this address')).toBe(true)

    unsubscribe()
  })

  it('opens bare external links in a new tab and never navigates the frame', async () => {
    const originalOpen = window.open
    let openedUrl: string | null = null
    let openedFeatures: string | null = null
    window.open = ((url: URL | string, _target?: string, features?: string) => {
      openedUrl = String(url)
      openedFeatures = features ?? null
      return null
    }) as typeof window.open

    openPreviewWithLinks('<a href="https://example.com/tickets" id="ext-link">Tickets</a>')
    render(<PreviewOverlay />)
    const { defaultPrevented } = await clickInPreview('#ext-link')
    expect(defaultPrevented).toBe(true)
    expect(openedUrl).toBe('https://example.com/tickets')
    expect(openedFeatures).toContain('noopener')
    expect(useEditorStore.getState().activePageId).toBe('page-1')

    window.open = originalOpen
  })

  it('lets target=_blank external links go through the browser untouched', async () => {
    const originalOpen = window.open
    window.open = (() => null) as typeof window.open

    openPreviewWithLinks('<a href="https://example.com/x" target="_blank" id="blank-link">X</a>')
    render(<PreviewOverlay />)
    const { defaultPrevented } = await clickInPreview('#blank-link')
    // Not intercepted — allow-popups handles it; window.open was never called
    // with our re-route (the spy above would only prove a call, so assert the
    // click itself was left alone).
    expect(defaultPrevented).toBe(false)

    window.open = originalOpen
  })

  it('leaves same-document anchor clicks native', async () => {
    openPreviewWithLinks('<a href="#speakers" id="hash-link">Speakers</a>')
    render(<PreviewOverlay />)
    const { defaultPrevented } = await clickInPreview('#hash-link')
    expect(defaultPrevented).toBe(false)
    expect(useEditorStore.getState().activePageId).toBe('page-1')
  })
})

// ---------------------------------------------------------------------------
// 4 — PreviewOverlay source-scan assertions
// ---------------------------------------------------------------------------

describe('PreviewOverlay — source enforcement', () => {
  const overlaySrc = readFileSync(
    new URL('../../admin/pages/site/preview/PreviewOverlay.tsx', import.meta.url),
    'utf-8',
  )

  it('has data-testid="preview-overlay" on the dialog', () => {
    expect(overlaySrc).toContain('data-testid="preview-overlay"')
  })

  it('has data-testid="preview-iframe" on the iframe', () => {
    expect(overlaySrc).toContain('data-testid="preview-iframe"')
  })

  it('iframe stays script-less: same-origin DOM access + popups, never allow-scripts', () => {
    // allow-same-origin lets the parent re-route link clicks (in-preview
    // navigation); allow-popups lets target=_blank external links open a tab.
    // allow-scripts stays absent — the preview document itself cannot execute.
    // (Match the attribute value exactly; prose mentioning the token would
    // false-positive a plain substring scan.)
    const sandboxValues = [...overlaySrc.matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1]!)
    expect(sandboxValues.length).toBeGreaterThan(0)
    for (const value of sandboxValues) expect(value).toBe('allow-same-origin allow-popups')
  })

  it('handles Escape key to close (Guideline #225)', () => {
    expect(overlaySrc).toContain("e.key === 'Escape'")
    expect(overlaySrc).toContain('closePreview()')
  })

  it('captures document.activeElement on open (WCAG 2.4.3 focus return)', () => {
    expect(overlaySrc).toContain('document.activeElement')
    expect(overlaySrc).toContain('triggerRef.current = document.activeElement')
  })

  it('restores focus to trigger on close (WCAG 2.4.3)', () => {
    expect(overlaySrc).toMatch(/else\s*\{[\s\S]*?\.focus\(\)/)
  })

  it('close button has aria-label="Close preview"', () => {
    expect(overlaySrc).toContain('aria-label="Close preview"')
  })

  it('close button uses the shared 44px Button size', () => {
    const closeActionStart = overlaySrc.indexOf('aria-label="Close preview"')
    const closeActionBlock = overlaySrc.slice(closeActionStart - 250, closeActionStart + 250)

    expect(closeActionBlock).toContain('<Button')
    expect(closeActionBlock).toContain('size="lg"')
  })

  it('backdrop has aria-hidden="true" (screen readers ignore it)', () => {
    expect(overlaySrc).toContain('aria-hidden="true"')
  })

  it('uses the CMS runtime preview boundary instead of bypassing server prefetch', () => {
    const previewHookSrc = readFileSync(
      new URL('../../admin/pages/site/preview/useRuntimePreviewDocument.ts', import.meta.url),
      'utf-8',
    )
    expect(previewHookSrc).toContain('buildCmsRuntimePreview(')
    expect(overlaySrc).not.toContain('publishPage(')
  })
})

// ---------------------------------------------------------------------------
// 4 — Happy-path golden: 2-node tree → expected HTML (Phase 7 deliverable)
//
// Task #185 requires: "Unit test: render a simple 2-node tree and assert the
// HTML output matches expected string."
// ---------------------------------------------------------------------------

describe('publishPage — 2-node tree golden test (Phase 7)', () => {
  const rootModule = makeModule('base.body', {
    canHaveChildren: true,
    render: (_props, children) => ({ html: children.join('') }),
  })

  const headingModule = makeModule('base.text', {
    canHaveChildren: false,
    render: (props) => ({
      html: `<h1 class="instatic-heading">${props['text'] ?? ''}</h1>`,
      css: '/* base.text */\n.instatic-heading { font-family: sans-serif; margin: 0; }',
    }),
  })

  const reg = makeRegistry({ 'base.body': rootModule, 'base.text': headingModule })

  it('renders a 2-node tree (root + heading) to a complete HTML document', () => {
    const page = makePage(
      {
        root: { moduleId: 'base.body', children: ['h1'] },
        h1: { moduleId: 'base.text', props: { text: 'Hello World' } },
      },
      'root',
    )
    const site = makeSite({ name: 'Golden Test', pages: [page] })

    const { html, filename } = publishPage(page, site, reg)

    // Document structure
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html')
    expect(html).toContain('<body>')
    expect(html).toContain('</html>')

    // Page content
    expect(html).toContain('<h1 class="instatic-heading">Hello World</h1>')

    // CSS injection (deduplicated)
    expect(html).toContain('.instatic-heading { font-family: sans-serif; margin: 0; }')

    // Filename derivation
    expect(filename).toBe('index.html')
  })

  it('HTML-escapes text props — XSS cannot reach the output', () => {
    const page = makePage(
      {
        root: { moduleId: 'base.body', children: ['h1'] },
        h1: { moduleId: 'base.text', props: { text: '<script>alert(1)</script>' } },
      },
      'root',
    )
    const site = makeSite({ pages: [page] })
    const { html } = publishPage(page, site, reg)

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('CSS deduplication — 3 heading nodes produce 1 CSS entry', () => {
    const containerModule = makeModule('base.container', {
      canHaveChildren: true,
      render: (_props, children) => ({ html: `<div>${children.join('')}</div>` }),
    })
    const regWithContainer = makeRegistry({
      'base.body': makeModule('base.body', {
        canHaveChildren: true,
        render: (_props, children) => ({ html: children.join('') }),
      }),
      'base.container': containerModule,
      'base.text': headingModule,
    })

    const page = makePage(
      {
        root: { moduleId: 'base.body', children: ['wrap'] },
        wrap: { moduleId: 'base.container', children: ['h1', 'h2', 'h3'] },
        h1: { moduleId: 'base.text', props: { text: 'A' } },
        h2: { moduleId: 'base.text', props: { text: 'B' } },
        h3: { moduleId: 'base.text', props: { text: 'C' } },
      },
      'root',
    )
    const site = makeSite({ pages: [page] })
    const { html } = publishPage(page, site, regWithContainer)

    // The text-module CSS marker appears exactly once
    const occurrences = (html.match(/\/\* base\.text \*\//g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('output contains CSP meta tag (Constraint #227)', () => {
    const page = makePage(
      { root: { moduleId: 'base.body', children: [] } },
      'root',
    )
    const site = makeSite({ pages: [page] })
    const { html } = publishPage(page, site, reg)
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("script-src 'none'")
  })

  it('output has zero editor artefacts', () => {
    const page = makePage(
      { root: { moduleId: 'base.body', children: [] } },
      'root',
    )
    const site = makeSite({ pages: [page] })
    const { html } = publishPage(page, site, reg)
    expect(html).not.toContain('data-testid')
    expect(html).not.toContain('zustand')
    expect(html).not.toContain('data-reactroot')
    expect(html).not.toContain('__editor')
  })
})
