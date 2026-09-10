/**
 * Helpers shared by the git CLI push: path normalization and export walk.
 * Extracted from the previous REST-API push so both tree semantics
 * (`targetDir` scoping) and file-walking stay identical.
 */

import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const MAX_FILE_BYTES = 100 * 1024 * 1024 // GitHub hard limit; no LFS here

export function normalizeTargetDir(targetDir: string): string {
  const trimmed = targetDir.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  if (!trimmed) return ''
  if (trimmed.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(`Invalid targetDir: ${JSON.stringify(targetDir)}`)
  }
  return trimmed
}

export type ExportFile = {
  relPath: string
  absPath: string
}

export async function walkExportFiles(exportDir: string): Promise<ExportFile[]> {
  const out: ExportFile[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absPath)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(absPath)
      if (info.size > MAX_FILE_BYTES) {
        const relPath = relative(exportDir, absPath).split(sep).join('/')
        throw new Error(
          `File exceeds the 100MB GitHub limit (no LFS): ${relPath} (${info.size} bytes)`,
        )
      }
      const relPath = relative(exportDir, absPath).split(sep).join('/')
      out.push({ relPath, absPath })
    }
  }

  await walk(exportDir)
  out.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return out
}
