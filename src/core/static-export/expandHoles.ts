import type { HoleKind } from './scanDynamic'
import type { ExportReportItem } from './types'

export type { HoleKind } from './scanDynamic'

export interface ExpandHolesHooks {
  pageUrl: string
  classify: (nodeId: string) => Promise<HoleKind> | HoleKind
  renderShared: (nodeId: string) => Promise<string>
}

export type ExpandHolesResult =
  | { ok: true; html: string; report: ExportReportItem[] }
  | { ok: false; html: string; report: ExportReportItem[] }

const HOLE_ELEMENT_RE =
  /<instatic-hole\b(?=[^>]*\bdata-instatic-hole="([^"]+)")[^>]*(?:>\s*<\/instatic-hole>|\/>)/g

const HOLE_RUNTIME_SCRIPT_RE =
  /<script\b[^>]*\bsrc="[^"]*hole-runtime\.js[^"]*"[^>]*>\s*<\/script>/gi

function extractHoleNodeId(elementHtml: string): string | null {
  const match = elementHtml.match(/\bdata-instatic-hole="([^"]+)"/)
  return match?.[1] ?? null
}

function stripHoleRuntimeScripts(html: string): string {
  return html.replace(HOLE_RUNTIME_SCRIPT_RE, '')
}

function hasRemainingHoles(html: string): boolean {
  return /<instatic-hole\b/i.test(html)
}

export async function applyHoleExpansion(
  html: string,
  hooks: ExpandHolesHooks,
): Promise<ExpandHolesResult> {
  const report: ExportReportItem[] = []
  const holes: { fullMatch: string; nodeId: string }[] = []

  for (const match of html.matchAll(HOLE_ELEMENT_RE)) {
    const fullMatch = match[0]
    const nodeId = match[1] ?? extractHoleNodeId(fullMatch)
    if (!nodeId) continue
    holes.push({ fullMatch, nodeId })
  }

  let resultHtml = html

  for (const { fullMatch, nodeId } of holes) {
    const kind = await hooks.classify(nodeId)

    if (kind === 'per-visitor' || kind === 'unknown') {
      report.push({
        severity: 'error',
        code: 'per-visitor-hole',
        message: `Cannot statically export per-visitor hole for node "${nodeId}" on ${hooks.pageUrl}`,
        pageUrl: hooks.pageUrl,
        nodeId,
      })
      return { ok: false, html, report }
    }

    const frozenHtml = await hooks.renderShared(nodeId)
    resultHtml = resultHtml.replace(fullMatch, frozenHtml)
    report.push({
      severity: 'info',
      code: 'shared-hole-frozen',
      message: `Inlined shared hole for node "${nodeId}" on ${hooks.pageUrl}`,
      pageUrl: hooks.pageUrl,
      nodeId,
    })
  }

  if (!hasRemainingHoles(resultHtml)) {
    resultHtml = stripHoleRuntimeScripts(resultHtml)
  }

  return { ok: true, html: resultHtml, report }
}
