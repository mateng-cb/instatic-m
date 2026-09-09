/**
 * DITExpo 首页 Super Import 的无头可行性检查（只构建 ImportPlan，不写库）。
 *
 *   cd Instatic
 *   bun run scripts/verify-ditexpo-import.ts
 */
import { GlobalWindow } from 'happy-dom'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import '@modules/base'
import { buildImportPlan, type FileMap } from '@core/siteImport'
import { makeEmptySiteDocument } from '../src/__tests__/siteImport/mockSite'

const happyWindow = new GlobalWindow({
  url: 'http://localhost/',
  settings: {
    disableCSSFileLoading: true,
    disableJavaScriptFileLoading: true,
  },
})
;(globalThis as Record<string, unknown>).window = happyWindow
;(globalThis as Record<string, unknown>).document = happyWindow.document
;(globalThis as Record<string, unknown>).DOMParser = happyWindow.DOMParser
;(globalThis as Record<string, unknown>).Node = happyWindow.Node
;(globalThis as Record<string, unknown>).HTMLElement = happyWindow.HTMLElement
;(globalThis as Record<string, unknown>).Element = happyWindow.Element
;(globalThis as Record<string, unknown>).Document = happyWindow.Document
;(globalThis as Record<string, unknown>).DocumentFragment = happyWindow.DocumentFragment

const PACK_ROOT = join(import.meta.dir, '../../DITExpohtml/doc/instatic-import-pack')
const REPORT_PATH = join(PACK_ROOT, '验证报告-import-plan.json')

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      out.push(...(await walkFiles(full)))
      continue
    }
    if (entry.name.startsWith('.')) continue
    if (/\.(md|ts|json)$/i.test(entry.name)) continue
    out.push(full)
  }
  return out
}

function guessMime(path: string): string | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html'
  if (lower.endsWith('.css')) return 'text/css'
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'application/javascript'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.ico')) return 'image/x-icon'
  if (lower.endsWith('.woff2')) return 'font/woff2'
  if (lower.endsWith('.woff')) return 'font/woff'
  return undefined
}

async function main() {
  const files = await walkFiles(PACK_ROOT)
  const fileMap: FileMap = { files: {} }
  for (const abs of files) {
    const key = relative(PACK_ROOT, abs).split(sep).join('/')
    fileMap.files[key] = {
      bytes: new Uint8Array(await Bun.file(abs).arrayBuffer()),
      mimeType: guessMime(key),
    }
  }

  const t0 = performance.now()
  const plan = buildImportPlan({
    fileMap,
    currentSite: makeEmptySiteDocument(),
  })
  const ms = Math.round(performance.now() - t0)

  const pageSummaries = plan.pages.map((p) => ({
    source: p.source,
    title: p.title,
    slug: p.slug,
    nodeCount: Object.keys(p.nodeFragment.nodes).length,
    rootIds: p.nodeFragment.rootIds,
    stripped: p.nodeFragment.stripped,
  }))

  const report = {
    ok: true,
    analyzedAt: new Date().toISOString(),
    durationMs: ms,
    fileCount: fileMap.size,
    pageCount: plan.pages.length,
    styleRuleCount: plan.styleRules.length,
    assetCount: plan.assets.length,
    colorTokenCount: plan.colors.length,
    warningCount: plan.warnings.length,
    warnings: plan.warnings.slice(0, 50),
    conflicts: {
      pages: plan.conflicts.pages.length,
      rules: plan.conflicts.rules.length,
      tokens: plan.conflicts.tokens.length,
      pageDetails: plan.conflicts.pages,
    },
    pages: pageSummaries,
    sampleStyleRules: plan.styleRules.slice(0, 20).map((r) => ({
      name: r.name,
      kind: r.kind,
      selector: r.selector,
    })),
  }

  await Bun.write(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({
    ok: true,
    durationMs: ms,
    fileCount: report.fileCount,
    pageCount: report.pageCount,
    styleRuleCount: report.styleRuleCount,
    assetCount: report.assetCount,
    warningCount: report.warningCount,
    conflicts: report.conflicts,
    pages: pageSummaries,
    reportPath: REPORT_PATH,
  }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
