import type { ExportLayout } from './types'

function normalizeUrlPath(url: string): string {
  const path = url.split(/[?#]/)[0] ?? url
  return path
}

function pathSegments(path: string): string[] {
  const trimmed = path.replace(/^\/+|\/+$/g, '')
  if (!trimmed) return []
  const segments = trimmed.split('/').filter(Boolean)
  for (const segment of segments) {
    if (segment === '..') {
      throw new Error('Invalid URL path segment: ..')
    }
  }
  return segments
}

/**
 * URL → 导出文件路径的唯一事实源。
 * `directory`（默认）：`/x` → `x/index.html`；`flat`：`/x` → `x.html`。
 */
export function exportPathForUrl(url: string, layout: ExportLayout = 'directory'): string {
  const path = normalizeUrlPath(url)
  if (path === '/') return 'index.html'
  const segments = pathSegments(path)
  if (layout === 'flat') return `${segments.join('/')}.html`
  return `${segments.join('/')}/index.html`
}

export function depthOfExportPath(exportPath: string): number {
  return exportPath.split('/').length - 1
}

export function hrefBetween(fromExportFile: string, toPath: string): string {
  const depth = depthOfExportPath(fromExportFile)
  if (depth === 0) return toPath
  return `${'../'.repeat(depth)}${toPath}`
}
