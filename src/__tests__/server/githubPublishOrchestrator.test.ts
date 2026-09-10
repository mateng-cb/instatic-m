/**
 * Orchestrator `publishSiteToGithub` — lightweight unit tests with mocked
 * export / push seams. Settings + token decryption use a real SQLite DB.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { gitDataApiPush } from '../../../server/github/gitDataApiPush'
import {
  GithubPublishError,
  publishSiteToGithub,
} from '../../../server/publish/githubPublish'
import { exportPublishedSiteStatic } from '../../../server/publish/staticExport'
import type { GitDataApiPushProgress } from '../../../server/github/types'
import { upsertGithubPublishSettings } from '../../../server/repositories/githubPublishSettings'
import { __resetMasterKeyCacheForTesting } from '../../../server/secrets/masterKey'

const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
const TEST_TOKEN = 'ghp_test_secret_value'
const TEST_REPO = 'https://github.com/acme/my-site'

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Windows may keep the SQLite handle open briefly after the test ends. */
async function safeCleanup(cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EBUSY') throw err
  }
}

describe('publishSiteToGithub orchestrator', () => {
  let testDb: TestDb
  let originalSecretKey: string | undefined
  const leftoverDirs: string[] = []

  beforeEach(async () => {
    originalSecretKey = process.env.INSTATIC_SECRET_KEY
    process.env.INSTATIC_SECRET_KEY = TEST_MASTER_KEY
    __resetMasterKeyCacheForTesting()
    testDb = await createTestDb()
  })

  afterEach(async () => {
    await Promise.all(
      leftoverDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    )
    if (originalSecretKey === undefined) delete process.env.INSTATIC_SECRET_KEY
    else process.env.INSTATIC_SECRET_KEY = originalSecretKey
    __resetMasterKeyCacheForTesting()
    await safeCleanup(() => testDb.cleanup())
  })

  it('throws token-missing when hasToken is false', async () => {
    await expect(
      publishSiteToGithub({
        db: testDb.db,
        uploadsDir: '/tmp/unused-uploads',
      }),
    ).rejects.toMatchObject({
      name: 'GithubPublishError',
      code: 'token-missing',
    })
  })

  it('keeps exportDir when push fails', async () => {
    await upsertGithubPublishSettings(testDb.db, {
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      targetDir: '',
      basePath: '',
      token: TEST_TOKEN,
    })

    let capturedOutDir = ''
    const exportFn: typeof exportPublishedSiteStatic = async (options) => {
      capturedOutDir = options.outDir
      await mkdir(options.outDir, { recursive: true })
      await writeFile(join(options.outDir, 'index.html'), '<html></html>', 'utf8')
      return {
        outDir: options.outDir,
        pageCount: 1,
        report: [{ severity: 'info', code: 'ok', message: 'exported' }],
      }
    }

    const pushFn: typeof gitDataApiPush = async () => {
      throw new Error('simulated push failure')
    }

    let caught: unknown
    try {
      await publishSiteToGithub({
        db: testDb.db,
        uploadsDir: '/tmp/unused-uploads',
        exportFn,
        pushFn,
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(GithubPublishError)
    const error = caught as GithubPublishError
    expect(error.code).toBe('push-failed')
    // The raw Git Data API failure text travels on the wire (the job's
    // failureFor passes it through) — "Branch does not exist: …" and friends
    // must reach the operator, not a generic "push failed".
    expect(error.message).toBe('simulated push failure')
    expect(error.exportDir).toBe(capturedOutDir)
    expect(await pathExists(capturedOutDir)).toBe(true)
    leftoverDirs.push(capturedOutDir)
  })

  it('deletes outDir on successful push', async () => {
    await upsertGithubPublishSettings(testDb.db, {
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      targetDir: 'docs',
      basePath: '/my-site',
      token: TEST_TOKEN,
    })

    let capturedOutDir = ''
    const exportFn: typeof exportPublishedSiteStatic = async (options) => {
      capturedOutDir = options.outDir
      expect(options.pathMode).toBe('basePath')
      expect(options.basePath).toBe('/my-site')
      await mkdir(options.outDir, { recursive: true })
      await writeFile(join(options.outDir, 'index.html'), '<html></html>', 'utf8')
      return {
        outDir: options.outDir,
        pageCount: 1,
        report: [{ severity: 'warning', code: 'form-static', message: 'form' }],
      }
    }

    const pushFn: typeof gitDataApiPush = async (input) => {
      expect(input.exportDir).toBe(capturedOutDir)
      expect(input.owner).toBe('acme')
      expect(input.repo).toBe('my-site')
      expect(input.branch).toBe('gh-pages')
      expect(input.targetDir).toBe('docs')
      return { commitSha: 'abc123', treeSha: 'tree456' }
    }

    const result = await publishSiteToGithub({
      db: testDb.db,
      uploadsDir: '/tmp/unused-uploads',
      exportFn,
      pushFn,
    })

    expect(result).toEqual({
      commitSha: 'abc123',
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      report: [{ severity: 'warning', code: 'form-static', message: 'form' }],
    })
    expect(await pathExists(capturedOutDir)).toBe(false)
  })

  it('forwards push progress to onPushProgress', async () => {
    await upsertGithubPublishSettings(testDb.db, {
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      targetDir: '',
      basePath: '',
      token: TEST_TOKEN,
    })

    const exportFn: typeof exportPublishedSiteStatic = async (options) => {
      await mkdir(options.outDir, { recursive: true })
      await writeFile(join(options.outDir, 'index.html'), '<html></html>', 'utf8')
      return { outDir: options.outDir, pageCount: 1, report: [] }
    }

    const pushFn: typeof gitDataApiPush = async (input) => {
      input.onProgress?.({
        phase: 'uploading',
        uploaded: 1,
        total: 2,
        currentPath: 'index.html',
      })
      return { commitSha: 'abc123', treeSha: 'tree456' }
    }

    const seen: GitDataApiPushProgress[] = []
    await publishSiteToGithub({
      db: testDb.db,
      uploadsDir: '/tmp/unused-uploads',
      exportFn,
      pushFn,
      onPushProgress: (progress) => seen.push({ ...progress }),
    })

    expect(seen).toEqual([
      { phase: 'uploading', uploaded: 1, total: 2, currentPath: 'index.html' },
    ])
  })

  it('passes commitMessage through to the push; omitted → push default', async () => {
    await upsertGithubPublishSettings(testDb.db, {
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      targetDir: '',
      basePath: '',
      token: TEST_TOKEN,
    })

    const exportFn: typeof exportPublishedSiteStatic = async (options) => {
      await mkdir(options.outDir, { recursive: true })
      await writeFile(join(options.outDir, 'index.html'), '<html></html>', 'utf8')
      return { outDir: options.outDir, pageCount: 1, report: [] }
    }

    const seenCommitMessages: Array<string | undefined> = []
    const pushFn: typeof gitDataApiPush = async (input) => {
      seenCommitMessages.push(input.commitMessage)
      return { commitSha: 'abc123', treeSha: 'tree456' }
    }

    await publishSiteToGithub({
      db: testDb.db,
      uploadsDir: '/tmp/unused-uploads',
      exportFn,
      pushFn,
    })

    await publishSiteToGithub({
      db: testDb.db,
      uploadsDir: '/tmp/unused-uploads',
      exportFn,
      pushFn,
      commitMessage: 'DITE site update',
    })

    expect(seenCommitMessages).toEqual([undefined, 'DITE site update'])
  })
})
