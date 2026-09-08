import { exportPathForUrl, hrefBetween } from './routeLayout'
import type { ExportLayout, PathMode } from './types'

export interface RewriteDocumentUrlsOptions {
  pathMode: PathMode
  layout: ExportLayout
  basePath: string
  exportFilePath: string
}

export interface RewriteRootAbsolutePathContext {
  pathMode: PathMode
  layout: ExportLayout
  basePath: string
  exportFilePath: string
}

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

export function normalizeBasePath(basePath: string): string {
  if (!basePath) return ''
  let normalized = basePath.startsWith('/') ? basePath : `/${basePath}`
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

function joinBasePath(basePath: string, pathPart: string): string {
  const normalized = normalizeBasePath(basePath)
  if (!normalized) return pathPart
  return `${normalized}${pathPart}`
}

export function isRootAbsoluteSitePath(path: string): boolean {
  if (!path.startsWith('/')) return false
  if (path.startsWith('//')) return false
  const lower = path.toLowerCase()
  if (lower.startsWith('/http:') || lower.startsWith('/https:')) return false
  if (lower.startsWith('/data:') || lower.startsWith('/mailto:')) return false
  return true
}

function isAssetPath(pathPart: string): boolean {
  return pathPart.startsWith('/_instatic/') || pathPart.startsWith('/uploads/')
}

function exportPathToDirectoryForm(exportPath: string): string {
  if (exportPath === 'index.html') return ''
  if (exportPath.endsWith('/index.html')) {
    return exportPath.slice(0, -'index.html'.length)
  }
  return exportPath
}

function relativePageHref(
  fromExportFile: string,
  urlPath: string,
  layout: ExportLayout,
): string {
  const targetExport = exportPathForUrl(urlPath, layout)
  // flat 布局没有目录形：目标就是导出文件本身。自链（target === from）
  // 也走 hrefBetween —— flat 下 './' 会解析到目录而非文件。
  if (layout === 'flat') return hrefBetween(fromExportFile, targetExport)
  if (targetExport === fromExportFile) return './'
  const targetDir = exportPathToDirectoryForm(targetExport)
  return hrefBetween(fromExportFile, targetDir)
}

function rewritePathPart(pathPart: string, ctx: RewriteRootAbsolutePathContext): string {
  if (ctx.pathMode === 'basePath') {
    return joinBasePath(ctx.basePath, pathPart)
  }
  if (isAssetPath(pathPart)) {
    return hrefBetween(ctx.exportFilePath, pathPart.slice(1))
  }
  return relativePageHref(ctx.exportFilePath, pathPart, ctx.layout)
}

export function rewriteRootAbsolutePath(
  path: string,
  ctx: RewriteRootAbsolutePathContext,
): string {
  if (!isRootAbsoluteSitePath(path)) return path
  const { pathPart, suffix } = splitPathQueryHash(path)
  return rewritePathPart(pathPart, ctx) + suffix
}

function rewriteSrcset(value: string, ctx: RewriteRootAbsolutePathContext): string {
  return value
    .split(',')
    .map((part) => {
      const trimmed = part.trim()
      if (!trimmed) return trimmed
      const spaceIndex = trimmed.search(/\s/)
      if (spaceIndex === -1) {
        return rewriteRootAbsolutePath(trimmed, ctx)
      }
      const url = trimmed.slice(0, spaceIndex)
      const descriptor = trimmed.slice(spaceIndex)
      return rewriteRootAbsolutePath(url, ctx) + descriptor
    })
    .join(', ')
}

function rewriteImportmapValue(
  value: unknown,
  ctx: RewriteRootAbsolutePathContext,
): unknown {
  if (typeof value === 'string') {
    return rewriteRootAbsolutePath(value, ctx)
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteImportmapValue(entry, ctx))
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      result[key] = rewriteImportmapValue(entry, ctx)
    }
    return result
  }
  return value
}

function rewriteImportmapJson(json: string, ctx: RewriteRootAbsolutePathContext): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return json
  }
  return JSON.stringify(rewriteImportmapValue(parsed, ctx))
}

function rewriteHtmlAttributes(html: string, ctx: RewriteRootAbsolutePathContext): string {
  return html.replace(
    /\b(href|src|poster|action)=(["'])(\/(?!\/)[^"']*)\2/gi,
    (match, attr, quote, path) => {
      const rewritten = rewriteRootAbsolutePath(path, ctx)
      return rewritten === path ? match : `${attr}=${quote}${rewritten}${quote}`
    },
  )
}

function rewriteSrcsetAttributes(html: string, ctx: RewriteRootAbsolutePathContext): string {
  return html.replace(/\bsrcset=(["'])([^"']*)\1/gi, (match, quote, value) => {
    const rewritten = rewriteSrcset(value, ctx)
    return rewritten === value ? match : `srcset=${quote}${rewritten}${quote}`
  })
}

/** Rewrite root-absolute paths inside CSS `url(...)` (incl. `image-set(...)`). */
export function rewriteStylesheetUrls(
  css: string,
  options: RewriteDocumentUrlsOptions,
): string {
  const ctx: RewriteRootAbsolutePathContext = {
    pathMode: options.pathMode,
    layout: options.layout,
    basePath: options.basePath,
    exportFilePath: options.exportFilePath,
  }
  return css.replace(
    /url\(\s*(['"]?)(\/(?!\/)[^'")\s]+)\1\s*\)/g,
    (match, _quote, path) => {
      const rewritten = rewriteRootAbsolutePath(path, ctx)
      return rewritten === path ? match : `url('${rewritten}')`
    },
  )
}

function rewriteCssUrls(html: string, ctx: RewriteRootAbsolutePathContext): string {
  return rewriteStylesheetUrls(html, {
    pathMode: ctx.pathMode,
    layout: ctx.layout,
    basePath: ctx.basePath,
    exportFilePath: ctx.exportFilePath,
  })
}

function rewriteImportmapScripts(html: string, ctx: RewriteRootAbsolutePathContext): string {
  return html.replace(
    /<script\b[^>]*\btype=(["'])importmap\1[^>]*>([\s\S]*?)<\/script>/gi,
    (match, _quote, json) => {
      const trimmed = json.trim()
      const rewritten = rewriteImportmapJson(trimmed, ctx)
      return rewritten === trimmed ? match : match.replace(trimmed, rewritten)
    },
  )
}

export function rewriteDocumentUrls(
  html: string,
  options: RewriteDocumentUrlsOptions,
): string {
  const ctx: RewriteRootAbsolutePathContext = {
    pathMode: options.pathMode,
    layout: options.layout,
    basePath: options.basePath,
    exportFilePath: options.exportFilePath,
  }
  let out = html
  out = rewriteHtmlAttributes(out, ctx)
  out = rewriteSrcsetAttributes(out, ctx)
  out = rewriteCssUrls(out, ctx)
  out = rewriteImportmapScripts(out, ctx)
  return out
}
