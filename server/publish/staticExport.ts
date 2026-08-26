import { dirname, join } from 'node:path'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import {
  buildExportTree,
  StaticExportError,
  type BuildExportTreeInput,
  type ExportFsAdapter,
} from '@core/static-export/buildExportTree'
import type { PathMode, StaticExportResult } from '@core/static-export/types'
import {
  NOT_FOUND_ARTEFACT_URL_PATH,
  readArtefact,
  readStaticAsset,
} from './staticArtefact'

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/')
}

/**
 * Reverse of `urlToDiskRelPath` in staticArtefact.ts:
 *   index.html          → /
 *   about.html          → /about
 *   posts/hello.html    → /posts/hello
 *   foo/index.html      → /foo/
 */
export function diskHtmlRelPathToUrl(relPath: string): string | null {
  const normalized = normalizeRelPath(relPath)
  if (normalized.startsWith('_instatic/')) return null
  if (normalized === `${NOT_FOUND_ARTEFACT_URL_PATH.slice(1)}.html`) return null
  if (normalized === 'index.html') return '/'
  if (normalized.endsWith('/index.html')) {
    const dir = normalized.slice(0, -'/index.html'.length)
    return dir ? `/${dir}/` : '/'
  }
  if (normalized.endsWith('.html')) {
    return `/${normalized.slice(0, -'.html'.length)}`
  }
  return null
}

async function walkPublishedHtmlFiles(slotDir: string, base = ''): Promise<string[]> {
  let entries
  try {
    entries = await readdir(slotDir, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (rel === '_instatic' || rel.startsWith('_instatic/')) continue
      files.push(...(await walkPublishedHtmlFiles(join(slotDir, entry.name), rel)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(rel)
    }
  }
  return files
}

function createExportFsAdapter(uploadsDir: string, outDir: string): ExportFsAdapter {
  return {
    async readPublicAsset(publicPath: string): Promise<Uint8Array | null> {
      if (publicPath.startsWith('/_instatic/')) {
        return readStaticAsset(uploadsDir, publicPath)
      }
      if (publicPath.startsWith('/uploads/')) {
        try {
          const buffer = await readFile(join(uploadsDir, publicPath.slice(1)))
          return new Uint8Array(buffer)
        } catch {
          return null
        }
      }
      return null
    },
    async writeFile(relPath: string, data: Uint8Array | string): Promise<void> {
      const dest = join(outDir, relPath)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, data)
    },
  }
}

export async function exportPublishedSiteStatic(options: {
  uploadsDir: string
  outDir: string
  pathMode: PathMode
  basePath: string
  expandHoles: BuildExportTreeInput['expandHoles']
}): Promise<StaticExportResult> {
  const { uploadsDir, outDir, pathMode, basePath, expandHoles } = options

  const homepage = await readArtefact(uploadsDir, '/')
  if (homepage === null) {
    throw new StaticExportError('Site has not been published yet', 'not-published')
  }

  const slotDir = join(uploadsDir, 'published', 'current')
  const htmlRelPaths = await walkPublishedHtmlFiles(slotDir)

  const pages: BuildExportTreeInput['pages'] = []
  for (const relPath of htmlRelPaths) {
    const url = diskHtmlRelPathToUrl(relPath)
    if (!url) continue
    const html = await readArtefact(uploadsDir, url)
    if (html === null) continue
    pages.push({ url, html })
  }

  pages.sort((a, b) => a.url.localeCompare(b.url))

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  return buildExportTree({
    pages,
    pathMode,
    basePath,
    outDir,
    fs: createExportFsAdapter(uploadsDir, outDir),
    expandHoles,
  })
}
