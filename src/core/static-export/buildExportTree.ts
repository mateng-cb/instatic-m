import { collectMediaRefs } from './collectMediaRefs'
import { applyHoleExpansion } from './expandHoles'
import { exportPathForUrl } from './routeLayout'
import { rewriteDocumentUrls, rewriteStylesheetUrls } from './rewriteUrls'
import { scanHtmlForStaticExportIssues } from './scanDynamic'
import type { ExportLayout, ExportReportItem, PathMode, StaticExportResult } from './types'

export interface ExportPageInput {
  url: string
  /** Already-loaded published HTML for this page */
  html: string
}

export interface ExportFsAdapter {
  /** Read bytes for a root-absolute public path like `/_instatic/css/x.css` or `/uploads/a.png` */
  readPublicAsset(publicPath: string): Promise<Uint8Array | null>
  writeFile(relPath: string, data: Uint8Array | string): Promise<void>
}

export interface BuildExportTreeInput {
  pages: ExportPageInput[]
  pathMode: PathMode
  layout: ExportLayout
  basePath: string
  /** Absolute export root — returned on the result object only; adapter writes relative to this. */
  outDir: string
  fs: ExportFsAdapter
  expandHoles: {
    classify: (
      nodeId: string,
      pageUrl: string,
    ) => Promise<'per-visitor' | 'shared' | 'unknown'> | 'per-visitor' | 'shared' | 'unknown'
    renderShared: (nodeId: string, pageUrl: string) => Promise<string>
  }
}

export class StaticExportError extends Error {
  readonly code: 'not-published' | 'per-visitor-hole' | 'write-failed'
  readonly report: ExportReportItem[]

  constructor(
    message: string,
    code: 'not-published' | 'per-visitor-hole' | 'write-failed',
    report: ExportReportItem[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'StaticExportError'
    this.code = code
    this.report = report
  }
}

const INSTATIC_PREFIX = '/_instatic/'
const EXCLUDED_INSTATIC_PREFIXES = ['/_instatic/hole', '/_instatic/form', '/_instatic/loop']

function splitPathQueryHash(path: string): { pathPart: string; suffix: string } {
  const queryIndex = path.indexOf('?')
  const hashIndex = path.indexOf('#')
  const cutIndex =
    queryIndex === -1
      ? hashIndex
      : hashIndex === -1
        ? queryIndex
        : Math.min(queryIndex, hashIndex)
  if (cutIndex === -1) return { pathPart: path, suffix: '' }
  return { pathPart: path.slice(0, cutIndex), suffix: path.slice(cutIndex) }
}

function isCopyableInstaticPath(pathPart: string): boolean {
  if (!pathPart.startsWith(INSTATIC_PREFIX)) return false
  for (const prefix of EXCLUDED_INSTATIC_PREFIXES) {
    if (pathPart === prefix || pathPart.startsWith(`${prefix}/`)) return false
  }
  return true
}

function addInstaticRef(seen: Set<string>, refs: string[], rawPath: string): void {
  if (!rawPath.startsWith('/')) return
  const { pathPart } = splitPathQueryHash(rawPath)
  if (!isCopyableInstaticPath(pathPart)) return
  if (seen.has(pathPart)) return
  seen.add(pathPart)
  refs.push(pathPart)
}

function collectFromSrcset(value: string, seen: Set<string>, refs: string[]): void {
  for (const part of value.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const spaceIndex = trimmed.search(/\s/)
    const url = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)
    addInstaticRef(seen, refs, url)
  }
}

export function collectInstaticAssetRefs(html: string): string[] {
  const seen = new Set<string>()
  const refs: string[] = []

  html.replace(
    /\b(href|src|poster)=(["'])(\/(?!\/)[^"']*)\2/gi,
    (_match, _attr, _quote, path) => {
      addInstaticRef(seen, refs, path)
      return _match
    },
  )

  html.replace(/\bsrcset=(["'])([^"']*)\1/gi, (_match, _quote, value) => {
    collectFromSrcset(value, seen, refs)
    return _match
  })

  html.replace(
    /url\(\s*(['"]?)(\/(?!\/)[^'")\s]+)\1\s*\)/g,
    (_match, _quote, path) => {
      addInstaticRef(seen, refs, path)
      return _match
    },
  )

  html.replace(
    /<script\b[^>]*\btype=(["'])importmap\1[^>]*>([\s\S]*?)<\/script>/gi,
    (_match, _quote, json) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(json.trim())
      } catch {
        return _match
      }
      collectImportmapInstaticRefs(parsed, seen, refs)
      return _match
    },
  )

  return refs
}

function collectImportmapInstaticRefs(value: unknown, seen: Set<string>, refs: string[]): void {
  if (typeof value === 'string') {
    addInstaticRef(seen, refs, value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectImportmapInstaticRefs(entry, seen, refs)
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      collectImportmapInstaticRefs(entry, seen, refs)
    }
  }
}

function isStylesheetPublicPath(publicPath: string): boolean {
  return publicPath.startsWith('/_instatic/css/') || publicPath.endsWith('.css')
}

/** Linked stylesheets carry background URLs — scan them before copying assets. */
async function expandAssetPathsFromLinkedStylesheets(
  assetPaths: Set<string>,
  fs: ExportFsAdapter,
): Promise<void> {
  for (const cssPath of [...assetPaths].filter(isStylesheetPublicPath)) {
    const bytes = await fs.readPublicAsset(cssPath)
    if (!bytes) continue
    const text = new TextDecoder().decode(bytes)
    for (const ref of collectMediaRefs(text)) {
      assetPaths.add(ref)
    }
  }
}

export async function buildExportTree(input: BuildExportTreeInput): Promise<StaticExportResult> {
  const report: ExportReportItem[] = []
  const assetPaths = new Set<string>()
  const pageUrls: string[] = []

  for (const page of input.pages) {
    pageUrls.push(page.url)

    const expanded = await applyHoleExpansion(page.html, {
      pageUrl: page.url,
      classify: (nodeId) => input.expandHoles.classify(nodeId, page.url),
      renderShared: (nodeId) => input.expandHoles.renderShared(nodeId, page.url),
    })

    if (!expanded.ok) {
      throw new StaticExportError(
        `Cannot statically export ${page.url}: dynamic holes cannot be frozen`,
        'per-visitor-hole',
        [...report, ...expanded.report],
      )
    }

    report.push(...expanded.report)

    const scanItems = scanHtmlForStaticExportIssues(expanded.html, { pageUrl: page.url }).filter(
      (item) => item.code !== 'hole-present',
    )
    report.push(...scanItems)

    for (const ref of collectMediaRefs(expanded.html)) {
      assetPaths.add(ref)
    }
    for (const ref of collectInstaticAssetRefs(expanded.html)) {
      assetPaths.add(ref)
    }

    const exportFilePath = exportPathForUrl(page.url, input.layout)
    const rewritten = rewriteDocumentUrls(expanded.html, {
      pathMode: input.pathMode,
      layout: input.layout,
      basePath: input.basePath,
      exportFilePath,
    })

    try {
      await input.fs.writeFile(exportFilePath, rewritten)
    } catch (err) {
      throw new StaticExportError(
        `Failed to write export page ${exportFilePath}`,
        'write-failed',
        report,
        { cause: err },
      )
    }
  }

  await expandAssetPathsFromLinkedStylesheets(assetPaths, input.fs)

  for (const publicPath of assetPaths) {
    const bytes = await input.fs.readPublicAsset(publicPath)
    const relPath = publicPath.slice(1)
    if (bytes === null) {
      report.push({
        severity: 'warning',
        code: 'missing-asset',
        message: `Missing asset ${publicPath}`,
      })
      continue
    }
    try {
      const payload: Uint8Array | string = isStylesheetPublicPath(publicPath)
        ? rewriteStylesheetUrls(new TextDecoder().decode(bytes), {
            pathMode: input.pathMode,
            layout: input.layout,
            basePath: input.basePath,
            exportFilePath: relPath,
          })
        : bytes
      await input.fs.writeFile(relPath, payload)
    } catch (err) {
      throw new StaticExportError(
        `Failed to write export asset ${relPath}`,
        'write-failed',
        report,
        { cause: err },
      )
    }
  }

  const manifest = {
    pathMode: input.pathMode,
    layout: input.layout,
    basePath: input.basePath,
    pages: pageUrls,
    report,
    exportedAt: new Date().toISOString(),
  }

  try {
    await input.fs.writeFile('manifest.json', JSON.stringify(manifest, null, 2))
  } catch (err) {
    throw new StaticExportError('Failed to write manifest.json', 'write-failed', report, {
      cause: err,
    })
  }

  return {
    outDir: input.outDir,
    pageCount: input.pages.length,
    report,
  }
}
