/**
 * Breakpoint — viewport definition stored on the site document.
 *
 * Each Breakpoint has an id, display label, viewport width in pixels, a CSS
 * media query, and a pixel-art-icons name shown in the editor toolbar.
 * `DEFAULT_BREAKPOINTS` seeds fresh sites with the canonical
 * mobile/tablet/desktop set.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// BreakpointSchema
// ---------------------------------------------------------------------------

export const BreakpointSchema = Type.Object({
  id: Type.String(),
  /** Display label e.g. "Mobile", "Tablet", "Desktop" */
  label: Type.String(),
  /** Viewport width in pixels */
  width: Type.Number(),
  /**
   * Viewport height in pixels — the basis the editor canvas uses to resolve
   * `vh`/`vmin`/… units in class rules for this breakpoint's frame. Optional:
   * legacy breakpoints without it fall back to `defaultBreakpointViewportHeight`
   * inferred from `width`.
   */
  height: Type.Optional(Type.Number()),
  /**
   * CSS media query used when this viewport context emits class overrides.
   * `width` is the editor frame size; `mediaQuery` is the published condition.
   * Missing legacy values default to `(max-width: <width>px)` in
   * parseBreakpoint.
   */
  mediaQuery: Type.Optional(Type.String()),
  /**
   * pixel-art-icons kebab-case icon name — e.g. "smartphone", "tablet", "monitor".
   * Falls back to "monitor" if missing or non-string — handled in parseBreakpoint.
   */
  icon: Type.String(),
  /**
   * Whether this viewport context renders a live preview iframe on the editor
   * canvas. EDITOR-ONLY — it has no effect on published CSS, which always uses
   * this context's `mediaQuery`. `undefined` is treated as `true` (framed) for
   * back-compat; responsive contexts added via the editing-context switcher
   * default to `false` so not every responsive size spawns an iframe. Toggle it
   * in Settings → Viewport contexts.
   */
  previewFrame: Type.Optional(Type.Boolean()),
})

export type Breakpoint = Static<typeof BreakpointSchema>

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { id: 'mobile',  label: 'Mobile',  width: 375,  height: 667,  mediaQuery: '(max-width: 375px)',  icon: 'smartphone' },
  { id: 'tablet',  label: 'Tablet',  width: 768,  height: 1024, mediaQuery: '(max-width: 768px)',  icon: 'tablet'     },
  { id: 'desktop', label: 'Desktop', width: 1440, height: 800,  mediaQuery: '(max-width: 1440px)', icon: 'monitor'    },
]

/**
 * Viewport height used to resolve viewport units for breakpoints that don't
 * define one. Phone-class widths get a classic 2x phone viewport (375×667 —
 * the design basis most mobile hero art is drawn for), tablets get a portrait
 * iPad, everything wider keeps the historic 800px canvas height.
 */
export function defaultBreakpointViewportHeight(width: number): number {
  if (width <= 480) return 667
  if (width <= 1024) return 1024
  return 800
}

/** The viewport (width × height) the editor canvas resolves viewport units against. */
export function breakpointViewport(breakpoint: Pick<Breakpoint, 'width' | 'height'>): { width: number; height: number } {
  return {
    width: breakpoint.width,
    height: breakpoint.height ?? defaultBreakpointViewportHeight(breakpoint.width),
  }
}

// ---------------------------------------------------------------------------
// Tolerant parsing
// ---------------------------------------------------------------------------

export function defaultBreakpointMediaQuery(width: number): string {
  return `(max-width: ${width}px)`
}

export function breakpointMediaQuery(breakpoint: Pick<Breakpoint, 'width' | 'mediaQuery'>): string {
  const query = breakpoint.mediaQuery?.trim()
  return query && query.length > 0 ? query : defaultBreakpointMediaQuery(breakpoint.width)
}

/** Parse a Breakpoint, providing a 'monitor' fallback for missing/invalid icon. */
export function parseBreakpoint(raw: unknown): Breakpoint | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string') return null
  if (typeof r.label !== 'string') return null
  if (typeof r.width !== 'number') return null
  const mediaQuery = typeof r.mediaQuery === 'string' && r.mediaQuery.trim().length > 0
    ? r.mediaQuery.trim()
    : defaultBreakpointMediaQuery(r.width)
  return {
    id: r.id,
    label: r.label,
    width: r.width,
    mediaQuery,
    icon: typeof r.icon === 'string' ? r.icon : 'monitor',
    ...(typeof r.height === 'number' ? { height: r.height } : {}),
    ...(typeof r.previewFrame === 'boolean' ? { previewFrame: r.previewFrame } : {}),
  }
}
