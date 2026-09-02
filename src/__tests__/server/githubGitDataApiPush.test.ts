/**
 * Git Data API push — pure unit tests with a mock `fetchImpl`.
 * No network; export tree is a real temp directory on disk.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitDataApiPush } from '../../../server/github/gitDataApiPush'

const OWNER = 'acme'
const REPO = 'site'
const BRANCH = 'gh-pages'
const TOKEN = 'ghp_test_token_do_not_log'

const REF_URL = `https://api.github.com/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`
const COMMIT_SHA = 'commit-parent-sha'
const BASE_TREE_SHA = 'base-tree-sha'
const NEW_TREE_SHA = 'new-tree-sha'
const NEW_COMMIT_SHA = 'new-commit-sha'

type MockCall = {
  method: string
  url: string
  body: unknown
  headers: Headers
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function makeExportDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'instatic-gh-push-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }
  return root
}

describe('gitDataApiPush', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  test('throws a clear error when the branch ref is missing (404)', async () => {
    const exportDir = await makeExportDir({ 'index.html': '<html></html>' })
    tempDirs.push(exportDir)

    const calls: MockCall[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({
        method,
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: new Headers(init?.headers),
      })
      expect(url).toBe(REF_URL)
      return jsonResponse(404, { message: 'Not Found' })
    }

    await expect(
      gitDataApiPush({
        token: TOKEN,
        owner: OWNER,
        repo: REPO,
        branch: BRANCH,
        targetDir: '',
        exportDir,
        fetchImpl,
      }),
    ).rejects.toThrow(/branch does not exist/i)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
    expect(calls[0]!.headers.get('Accept')).toBe('application/vnd.github+json')
    expect(calls[0]!.headers.get('X-GitHub-Api-Version')).toBe('2022-11-28')
  })

  test('happy path targetDir "" replaces the whole branch tip tree', async () => {
    const exportDir = await makeExportDir({
      'index.html': '<html>hi</html>',
      '_instatic/css/a.css': 'body{}',
    })
    tempDirs.push(exportDir)

    const calls: MockCall[] = []
    const blobShas = new Map<string, string>()
    let blobSeq = 0

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({
        method,
        url,
        body,
        headers: new Headers(init?.headers),
      })

      if (method === 'GET' && url === REF_URL) {
        return jsonResponse(200, { object: { sha: COMMIT_SHA, type: 'commit' } })
      }
      if (method === 'GET' && url.endsWith(`/git/commits/${COMMIT_SHA}`)) {
        return jsonResponse(200, {
          sha: COMMIT_SHA,
          tree: { sha: BASE_TREE_SHA },
          message: 'old',
        })
      }
      if (method === 'POST' && url.endsWith('/git/blobs')) {
        blobSeq += 1
        const sha = `blob-sha-${blobSeq}`
        const content = Buffer.from(body.content, body.encoding ?? 'utf-8').toString('utf8')
        blobShas.set(content, sha)
        return jsonResponse(201, { sha, encoding: 'base64' })
      }
      if (method === 'POST' && url.endsWith('/git/trees')) {
        expect(body.base_tree).toBeUndefined()
        const paths = (body.tree as Array<{ path: string }>).map((t) => t.path).sort()
        expect(paths).toEqual(['_instatic/css/a.css', 'index.html'])
        for (const entry of body.tree as Array<{ mode: string; type: string; sha: string }>) {
          expect(entry.mode).toBe('100644')
          expect(entry.type).toBe('blob')
          expect(entry.sha).toMatch(/^blob-sha-/)
        }
        return jsonResponse(201, { sha: NEW_TREE_SHA })
      }
      if (method === 'POST' && url.endsWith('/git/commits')) {
        expect(body).toMatchObject({
          message: 'Publish site from Instatic',
          tree: NEW_TREE_SHA,
          parents: [COMMIT_SHA],
        })
        return jsonResponse(201, { sha: NEW_COMMIT_SHA, tree: { sha: NEW_TREE_SHA } })
      }
      if (method === 'PATCH' && url.endsWith(`/git/refs/heads/${BRANCH}`)) {
        expect(body).toMatchObject({ sha: NEW_COMMIT_SHA })
        return jsonResponse(200, { object: { sha: NEW_COMMIT_SHA } })
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`)
    }

    const result = await gitDataApiPush({
      token: TOKEN,
      owner: OWNER,
      repo: REPO,
      branch: BRANCH,
      targetDir: '',
      exportDir,
      fetchImpl,
    })

    expect(result).toEqual({ commitSha: NEW_COMMIT_SHA, treeSha: NEW_TREE_SHA })

    const methods = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)
    expect(methods[0]).toContain('GET')
    expect(methods[0]).toContain('/git/ref/heads/')
    expect(methods.some((m) => m.startsWith('GET') && m.includes('/git/commits/'))).toBe(true)
    expect(methods.filter((m) => m.startsWith('POST') && m.endsWith('/git/blobs'))).toHaveLength(2)
    expect(methods.some((m) => m.startsWith('POST') && m.endsWith('/git/trees'))).toBe(true)
    expect(methods.some((m) => m.startsWith('POST') && m.endsWith('/git/commits'))).toBe(true)
    expect(methods.at(-1)).toMatch(/^PATCH .*\/git\/refs\/heads\//)

    // Blobs before tree; tree before commit; commit before ref update
    const blobIdx = methods.findIndex((m) => m.includes('/git/blobs'))
    const treeIdx = methods.findIndex((m) => m.endsWith('/git/trees'))
    const commitIdx = methods.findIndex((m) => m.endsWith('/git/commits'))
    const refIdx = methods.findIndex((m) => m.includes('/git/refs/heads/'))
    expect(blobIdx).toBeGreaterThan(-1)
    expect(treeIdx).toBeGreaterThan(blobIdx)
    expect(commitIdx).toBeGreaterThan(treeIdx)
    expect(refIdx).toBeGreaterThan(commitIdx)

    expect(blobShas.has('<html>hi</html>')).toBe(true)
    expect(blobShas.has('body{}')).toBe(true)

    for (const call of calls) {
      const auth = call.headers.get('Authorization')
      expect(auth).toBe(`Bearer ${TOKEN}`)
    }
  })

  test('targetDir "docs" replaces subtree and keeps sibling paths', async () => {
    const exportDir = await makeExportDir({
      'index.html': '<html>docs</html>',
    })
    tempDirs.push(exportDir)

    const calls: MockCall[] = []
    let createdTreePaths: string[] | null = null

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({
        method,
        url,
        body,
        headers: new Headers(init?.headers),
      })

      if (method === 'GET' && url === REF_URL) {
        return jsonResponse(200, { object: { sha: COMMIT_SHA, type: 'commit' } })
      }
      if (method === 'GET' && url.endsWith(`/git/commits/${COMMIT_SHA}`)) {
        return jsonResponse(200, {
          sha: COMMIT_SHA,
          tree: { sha: BASE_TREE_SHA },
        })
      }
      if (method === 'GET' && url.includes(`/git/trees/${BASE_TREE_SHA}`)) {
        expect(url).toContain('recursive=1')
        return jsonResponse(200, {
          sha: BASE_TREE_SHA,
          truncated: false,
          tree: [
            { path: 'README.md', mode: '100644', type: 'blob', sha: 'readme-blob' },
            { path: 'docs', mode: '040000', type: 'tree', sha: 'docs-tree' },
            { path: 'docs/old.html', mode: '100644', type: 'blob', sha: 'old-blob' },
          ],
        })
      }
      if (method === 'POST' && url.endsWith('/git/blobs')) {
        return jsonResponse(201, { sha: 'new-docs-index-blob' })
      }
      if (method === 'POST' && url.endsWith('/git/trees')) {
        expect(body.base_tree).toBeUndefined()
        createdTreePaths = (body.tree as Array<{ path: string }>).map((t) => t.path).sort()
        return jsonResponse(201, { sha: NEW_TREE_SHA })
      }
      if (method === 'POST' && url.endsWith('/git/commits')) {
        return jsonResponse(201, { sha: NEW_COMMIT_SHA })
      }
      if (method === 'PATCH' && url.endsWith(`/git/refs/heads/${BRANCH}`)) {
        return jsonResponse(200, { object: { sha: NEW_COMMIT_SHA } })
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`)
    }

    const result = await gitDataApiPush({
      token: TOKEN,
      owner: OWNER,
      repo: REPO,
      branch: BRANCH,
      targetDir: 'docs',
      exportDir,
      fetchImpl,
    })

    expect(result.commitSha).toBe(NEW_COMMIT_SHA)
    expect(createdTreePaths).toEqual(['README.md', 'docs/index.html'])
    expect(createdTreePaths).not.toContain('docs/old.html')
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('recursive=1'))).toBe(true)
  })
})
