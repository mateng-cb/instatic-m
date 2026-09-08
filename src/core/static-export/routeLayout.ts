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

export function exportPathForUrl(url: string): string {
  const path = normalizeUrlPath(url)
  if (path === '/') return 'index.html'
  const segments = pathSegments(path)
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
