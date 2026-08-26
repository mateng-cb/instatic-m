const UPLOADS_PREFIX = '/uploads/'

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

function addUploadsRef(seen: Set<string>, refs: string[], rawPath: string): void {
  if (!rawPath.startsWith('/')) return
  const { pathPart } = splitPathQueryHash(rawPath)
  if (!pathPart.startsWith(UPLOADS_PREFIX)) return
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
    addUploadsRef(seen, refs, url)
  }
}

export function collectMediaRefs(html: string): string[] {
  const seen = new Set<string>()
  const refs: string[] = []

  html.replace(
    /\b(href|src|poster)=(["'])(\/(?!\/)[^"']*)\2/gi,
    (_match, _attr, _quote, path) => {
      addUploadsRef(seen, refs, path)
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
      addUploadsRef(seen, refs, path)
      return _match
    },
  )

  return refs
}
