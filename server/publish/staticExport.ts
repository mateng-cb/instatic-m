import { dirname, join, relative } from 'node:path'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
import { createStoredZipStream, type StoredZipEntry } from '../archive/storedZip'

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

/**
 * Public URL `/uploads/foo.png` is stored on disk as `{uploadsDir}/foo.png`
 * (the `/uploads/` prefix is the HTTP mount, not a subdirectory). Same
 * convention as plugin/font assets: strip `/uploads/` then join uploadsDir.
 */
export function diskRelPathForUploadsPublicUrl(publicPath: string): string | null {
  if (!publicPath.startsWith('/uploads/')) return null
  const rel = publicPath.slice('/uploads/'.length)
  return rel.length > 0 ? rel : null
}

function createExportFsAdapter(uploadsDir: string, outDir: string): ExportFsAdapter {
  return {
    async readPublicAsset(publicPath: string): Promise<Uint8Array | null> {
      if (publicPath.startsWith('/_instatic/')) {
        return readStaticAsset(uploadsDir, publicPath)
      }
      const uploadsRel = diskRelPathForUploadsPublicUrl(publicPath)
      if (uploadsRel !== null) {
        try {
          const buffer = await readFile(join(uploadsDir, uploadsRel))
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

  // "Published" means the current slot has at least one baked HTML page.
  // Do NOT require `/` → index.html: HTML imports often land as `/index` or
  // `/index-2` while still being a successful Publish.
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

  if (pages.length === 0) {
    throw new StaticExportError('Site has not been published yet', 'not-published')
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

async function walkExportFiles(
  dir: string,
  base = dir,
): Promise<{ relPath: string; absPath: string; sizeBytes: number }[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const files: { relPath: string; absPath: string; sizeBytes: number }[] = []
  for (const entry of entries) {
    const absPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkExportFiles(absPath, base)))
      continue
    }
    if (!entry.isFile()) continue
    const relPath = relative(base, absPath).replace(/\\/g, '/')
    const fileStat = await stat(absPath)
    files.push({ relPath, absPath, sizeBytes: fileStat.size })
  }
  return files
}

export async function collectExportZipEntries(outDir: string): Promise<StoredZipEntry[]> {
  const files = await walkExportFiles(outDir)
  files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return files.map(({ relPath, absPath, sizeBytes }) => ({
    path: relPath,
    sizeBytes,
    source: absPath,
  }))
}

export function createExportZipStream(outDir: string): Promise<ReadableStream<Uint8Array>> {
  return collectExportZipEntries(outDir).then((entries) => createStoredZipStream(entries))
}
