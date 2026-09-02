/**
 * Push a Phase A static-export directory to GitHub via the Git Data API
 * (blobs → tree → commit → update ref). No local `git` binary.
 *
 * Tree semantics match ordinary git commits:
 * - `targetDir === ''` → new root tree is ONLY the export files (full tip replace).
 * - non-empty `targetDir` → drop prior paths under that prefix, keep siblings,
 *   add export files as `targetDir/{relPath}`.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { GitDataApiPushInput, GitDataApiPushResult } from './types'

export type { GitDataApiPushInput, GitDataApiPushResult } from './types'

const API_BASE = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const MAX_BLOB_BYTES = 100 * 1024 * 1024
const DEFAULT_COMMIT_MESSAGE = 'Publish site from Instatic'
const MAX_ATTEMPTS = 4 // 1 initial + up to 3 retries on 429/5xx

type GhTreeEntry = {
  path: string
  mode: string
  type: 'blob' | 'tree' | 'commit'
  sha: string
}

type FlatBlobEntry = {
  path: string
  mode: string
  type: 'blob'
  sha: string
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  }
}

function normalizeTargetDir(targetDir: string): string {
  const trimmed = targetDir.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  if (!trimmed) return ''
  if (trimmed.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(`Invalid targetDir: ${JSON.stringify(targetDir)}`)
  }
  return trimmed
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function githubRequest(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<Response> {
  let lastStatus = 0
  let lastBody = ''

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetchImpl(url, {
      method,
      headers: {
        ...githubHeaders(token),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (res.status !== 429 && res.status < 500) {
      return res
    }

    lastStatus = res.status
    lastBody = await res.text().catch(() => '')
    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(50 * 2 ** attempt)
    }
  }

  throw new Error(
    `GitHub API ${method} ${new URL(url).pathname} failed after retries: HTTP ${lastStatus}${
      lastBody ? ` — ${lastBody.slice(0, 200)}` : ''
    }`,
  )
}

async function readJson<T>(res: Response, context: string): Promise<T> {
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${context}: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`)
  }
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new Error(`${context}: invalid JSON response`, { cause: err })
  }
}

async function walkExportFiles(
  exportDir: string,
): Promise<Array<{ relPath: string; absPath: string; size: number }>> {
  const out: Array<{ relPath: string; absPath: string; size: number }> = []

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
      if (info.size > MAX_BLOB_BYTES) {
        const relPath = relative(exportDir, absPath).split(sep).join('/')
        throw new Error(
          `File exceeds the 100MB GitHub blob limit (no LFS): ${relPath} (${info.size} bytes)`,
        )
      }
      const relPath = relative(exportDir, absPath).split(sep).join('/')
      out.push({ relPath, absPath, size: info.size })
    }
  }

  await walk(exportDir)
  out.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return out
}

function isUnderTargetDir(path: string, targetDir: string): boolean {
  return path === targetDir || path.startsWith(`${targetDir}/`)
}

export async function gitDataApiPush(input: GitDataApiPushInput): Promise<GitDataApiPushResult> {
  const {
    token,
    owner,
    repo,
    branch,
    exportDir,
    commitMessage = DEFAULT_COMMIT_MESSAGE,
    fetchImpl = fetch,
  } = input
  const targetDir = normalizeTargetDir(input.targetDir)

  const repoBase = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const refPath = `heads/${branch}`

  const refRes = await githubRequest(fetchImpl, token, 'GET', `${repoBase}/git/ref/${refPath}`)
  if (refRes.status === 404) {
    throw new Error(
      `Branch does not exist: ${branch}. Create the branch on GitHub before publishing.`,
    )
  }
  const ref = await readJson<{ object: { sha: string } }>(
    refRes,
    `GET git/ref/${refPath}`,
  )
  const parentCommitSha = ref.object.sha

  const commitRes = await githubRequest(
    fetchImpl,
    token,
    'GET',
    `${repoBase}/git/commits/${parentCommitSha}`,
  )
  const parentCommit = await readJson<{ tree: { sha: string } }>(
    commitRes,
    `GET git/commits/${parentCommitSha}`,
  )
  const baseTreeSha = parentCommit.tree.sha

  const files = await walkExportFiles(exportDir)
  const blobEntries: FlatBlobEntry[] = []

  for (const file of files) {
    const bytes = await readFile(file.absPath)
    const blobRes = await githubRequest(fetchImpl, token, 'POST', `${repoBase}/git/blobs`, {
      content: bytes.toString('base64'),
      encoding: 'base64',
    })
    const blob = await readJson<{ sha: string }>(blobRes, 'POST git/blobs')
    const path = targetDir ? `${targetDir}/${file.relPath}` : file.relPath
    blobEntries.push({
      path,
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    })
  }

  let treeEntries: FlatBlobEntry[]

  if (targetDir === '') {
    treeEntries = blobEntries
  } else {
    const treeRes = await githubRequest(
      fetchImpl,
      token,
      'GET',
      `${repoBase}/git/trees/${baseTreeSha}?recursive=1`,
    )
    const existing = await readJson<{ tree: GhTreeEntry[]; truncated?: boolean }>(
      treeRes,
      `GET git/trees/${baseTreeSha}?recursive=1`,
    )
    if (existing.truncated) {
      throw new Error(
        `GitHub recursive tree for ${owner}/${repo}@${branch} was truncated; repository is too large for a single subtree replace.`,
      )
    }

    const kept: FlatBlobEntry[] = []
    for (const entry of existing.tree) {
      if (entry.type !== 'blob') continue
      if (isUnderTargetDir(entry.path, targetDir)) continue
      kept.push({
        path: entry.path,
        mode: entry.mode,
        type: 'blob',
        sha: entry.sha,
      })
    }
    treeEntries = [...kept, ...blobEntries]
  }

  const treeRes = await githubRequest(fetchImpl, token, 'POST', `${repoBase}/git/trees`, {
    tree: treeEntries,
  })
  const newTree = await readJson<{ sha: string }>(treeRes, 'POST git/trees')

  const commitResCreate = await githubRequest(fetchImpl, token, 'POST', `${repoBase}/git/commits`, {
    message: commitMessage,
    tree: newTree.sha,
    parents: [parentCommitSha],
  })
  const newCommit = await readJson<{ sha: string }>(commitResCreate, 'POST git/commits')

  const refUpdateRes = await githubRequest(
    fetchImpl,
    token,
    'PATCH',
    `${repoBase}/git/refs/${refPath}`,
    { sha: newCommit.sha },
  )
  await readJson(refUpdateRes, `PATCH git/refs/${refPath}`)

  return {
    commitSha: newCommit.sha,
    treeSha: newTree.sha,
  }
}
