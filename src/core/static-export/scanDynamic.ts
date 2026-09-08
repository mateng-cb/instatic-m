import type { ExportReportItem } from './types'

export type HoleKind = 'per-visitor' | 'shared' | 'unknown'

const HOLE_ATTR_RE = /data-instatic-hole="([^"]+)"/g
const FORM_ACTION_RE = /<form\b[^>]*\baction="([^"]*\/_instatic\/form[^"]*)"[^>]*>/gi

export interface ScanHtmlOptions {
  pageUrl: string
}

/**
 * Map a dynamicDetection reason string (or similar) to HoleKind.
 * per-visitor / perVisitor → 'per-visitor'
 * request-dependent / shared / anything else that is still a hole but not per-visitor → 'shared'
 * missing/empty → 'unknown'
 */
export function classifyHoleKind(reason: string | undefined | null): HoleKind {
  if (reason == null || reason.trim() === '') return 'unknown'
  const normalized = reason.toLowerCase()
  if (normalized.includes('per-visitor') || reason.includes('perVisitor')) {
    return 'per-visitor'
  }
  return 'shared'
}

export function scanHtmlForStaticExportIssues(
  html: string,
  { pageUrl }: ScanHtmlOptions,
): ExportReportItem[] {
  const items: ExportReportItem[] = []

  for (const match of html.matchAll(HOLE_ATTR_RE)) {
    const nodeId = match[1]
    if (!nodeId) continue
    items.push({
      severity: 'info',
      code: 'hole-present',
      message: `Dynamic hole placeholder for node "${nodeId}" on ${pageUrl}`,
      pageUrl,
      nodeId,
    })
  }

  for (const match of html.matchAll(FORM_ACTION_RE)) {
    const action = match[1]
    if (!action) continue
    items.push({
      severity: 'warning',
      code: 'form-static',
      message: `CMS form posts to ${action}; static export cannot run server-side handlers`,
      pageUrl,
    })
  }

  return items
}
