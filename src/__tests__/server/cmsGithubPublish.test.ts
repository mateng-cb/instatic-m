/**
 * Integration tests — GitHub publish settings + the local push kit endpoint
 * (settings persistence, step-up gating, kit ZIP download semantics).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbClient } from '../../../server/db/client'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { handleGithubPublishRoutes } from '../../../server/handlers/cms/githubPublish'
import { prepareInactiveSlot, swapSlot, writeArtefact } from '../../../server/publish/staticArtefact'
import { SESSION_COOKIE_NAME } from '../../../server/auth/tokens'
import { stampSocketIp } from '../../../server/auth/security'
import { __resetMasterKeyCacheForTesting } from '../../../server/secrets/masterKey'
import { createTestDb } from '../helpers/createTestDb'

const VALID_LOGIN_PHRASE = 'long-enough-phrase'
const EMAIL = 'owner@example.com'
const IP = '203.0.113.10'
const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
const TEST_TOKEN = 'ghp_test_secret_value_for_handlers'
const TEST_REPO = 'https://github.com/mateng-cb/instatic-dite'

async function safeCleanup(cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EBUSY') throw err
  }
}

async function setup(db: DbClient): Promise<void> {
  const res = await handleCmsRequest(
    new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteName: 'Push Kit Test', email: EMAIL, password: VALID_LOGIN_PHRASE }),
    }),
    db,
  )
  expect(res.status).toBe(201)
}

function cookieFromSetCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0] ?? ''
  expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
  return cookie
}

async function login(db: DbClient): Promise<string> {
  const req = new Request('http://localhost/admin/api/cms/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: VALID_LOGIN_PHRASE }),
  })
  stampSocketIp(req, IP)
  const res = await handleCmsRequest(req, db)
  expect(res.status).toBe(200)
  return cookieFromSetCookie(res)
}

async function completeStepUp(db: DbClient, cookie: string): Promise<string> {
  const req = new Request('http://localhost/admin/api/cms/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: VALID_LOGIN_PHRASE }),
  })
  stampSocketIp(req, IP)
  req.headers.set('cookie', cookie)
  const res = await handleCmsRequest(req, db)
  expect(res.status).toBe(200)
  return cookieFromSetCookie(res)
}

function withCookie(req: Request, cookie: string): Request {
  req.headers.set('cookie', cookie)
  return req
}

function settingsRequest(method: 'GET' | 'PUT', cookie?: string, body?: unknown): Request {
  const req = new Request('http://localhost/admin/api/cms/github-publish/settings', {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (cookie) withCookie(req, cookie)
  return req
}

function pushPackageRequest(cookie?: string, body: unknown = {}): Request {
  const req = new Request('http://localhost/admin/api/cms/github-publish/push-package', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (cookie) withCookie(req, cookie)
  return req
}

/** A minimal published one-page site the push kit can export. */
async function publishedUploadsDir(): Promise<string> {
  const uploadsDir = await mkdtemp(join(tmpdir(), 'push-kit-api-uploads-'))
  const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
  await writeArtefact(slotDir, '/', '<!DOCTYPE html><html><body>kit</body></html>')
  await swapSlot(uploadsDir, slot)
  return uploadsDir
}

describe('GitHub publish HTTP handlers', () => {
  let originalSecretKey: string | undefined
  const tempDirs: string[] = []

  beforeEach(() => {
    originalSecretKey = process.env.INSTATIC_SECRET_KEY
    process.env.INSTATIC_SECRET_KEY = TEST_MASTER_KEY
    __resetMasterKeyCacheForTesting()
  })

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    if (originalSecretKey === undefined) delete process.env.INSTATIC_SECRET_KEY
    else process.env.INSTATIC_SECRET_KEY = originalSecretKey
    __resetMasterKeyCacheForTesting()
  })

  it('GET settings returns 401 when unauthenticated', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const res = await handleGithubPublishRoutes(settingsRequest('GET'), db)
      expect(res?.status).toBe(401)
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('GET settings returns a wire-safe view with hasToken and no token key', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await login(db)

      const emptyRes = await handleGithubPublishRoutes(settingsRequest('GET', cookie), db)
      expect(emptyRes?.status).toBe(200)
      const emptyBody = await emptyRes!.json() as Record<string, unknown>
      expect(emptyBody.hasToken).toBe(false)
      expect(Object.hasOwn(emptyBody, 'token')).toBe(false)
      expect(Object.hasOwn(emptyBody, 'tokenCiphertext')).toBe(false)

      const putRes = await handleGithubPublishRoutes(
        settingsRequest('PUT', cookie, {
          repoUrl: TEST_REPO,
          branch: 'gh-pages',
          basePath: '/instatic-dite',
          token: TEST_TOKEN,
        }),
        db,
      )
      expect(putRes?.status).toBe(200)
      const putBody = await putRes!.json() as Record<string, unknown>
      expect(putBody.hasToken).toBe(true)
      expect(putBody.repoUrl).toBe(TEST_REPO)
      expect(putBody.owner).toBe('mateng-cb')
      expect(putBody.repo).toBe('instatic-dite')
      expect(JSON.stringify(putBody)).not.toContain(TEST_TOKEN)
      expect(putBody.targetDir).toBeUndefined()

      const getRes = await handleGithubPublishRoutes(settingsRequest('GET', cookie), db)
      expect(getRes?.status).toBe(200)
      const getBody = await getRes!.json() as Record<string, unknown>
      expect(getBody.hasToken).toBe(true)
      expect(JSON.stringify(getBody)).not.toContain(TEST_TOKEN)
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('PUT settings returns 400 for an invalid repo URL or branch', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await login(db)

      const badHost = await handleGithubPublishRoutes(
        settingsRequest('PUT', cookie, {
          repoUrl: 'https://gitlab.com/acme/my-site',
          branch: 'gh-pages',
          basePath: '',
        }),
        db,
      )
      expect(badHost?.status).toBe(400)

      const badBranch = await handleGithubPublishRoutes(
        settingsRequest('PUT', cookie, {
          repoUrl: TEST_REPO,
          branch: 'gh-pages; rm -rf',
          basePath: '',
        }),
        db,
      )
      expect(badBranch?.status).toBe(400)
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('POST push-package requires step-up after pages.publish', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await login(db)
      const uploadsDir = await publishedUploadsDir()
      tempDirs.push(uploadsDir)

      const needsStepUp = await handleGithubPublishRoutes(
        pushPackageRequest(cookie, { embedToken: false }),
        db,
        { uploadsDir },
      )
      expect(needsStepUp?.status).toBe(401)
      const stepUpBody = await needsStepUp!.json() as { error: string }
      expect(stepUpBody.error).toBe('step_up_required')
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('POST push-package returns 400 when no repository is configured', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await completeStepUp(db, await login(db))
      const uploadsDir = await publishedUploadsDir()
      tempDirs.push(uploadsDir)

      const res = await handleGithubPublishRoutes(
        pushPackageRequest(cookie, { embedToken: false }),
        db,
        { uploadsDir },
      )
      expect(res?.status).toBe(400)
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('POST push-package returns 400 when embedding without a stored token', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await completeStepUp(db, await login(db))
      const uploadsDir = await publishedUploadsDir()
      tempDirs.push(uploadsDir)

      await handleGithubPublishRoutes(
        settingsRequest('PUT', cookie, {
          repoUrl: TEST_REPO,
          branch: 'gh-pages',
          basePath: '/instatic-dite',
        }),
        db,
      )

      const res = await handleGithubPublishRoutes(
        pushPackageRequest(cookie, { embedToken: true }),
        db,
        { uploadsDir },
      )
      expect(res?.status).toBe(400)
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('POST push-package returns 409 when the site has not been published', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await completeStepUp(db, await login(db))
      const emptyUploads = await mkdtemp(join(tmpdir(), 'push-kit-api-empty-'))
      tempDirs.push(emptyUploads)

      await handleGithubPublishRoutes(
        settingsRequest('PUT', cookie, {
          repoUrl: TEST_REPO,
          branch: 'gh-pages',
          basePath: '/instatic-dite',
          token: TEST_TOKEN,
        }),
        db,
      )

      const res = await handleGithubPublishRoutes(
        pushPackageRequest(cookie, { embedToken: true }),
        db,
        { uploadsDir: emptyUploads },
      )
      expect(res?.status).toBe(409)
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('POST push-package streams a ZIP kit for a configured, published site', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await completeStepUp(db, await login(db))
      const uploadsDir = await publishedUploadsDir()
      tempDirs.push(uploadsDir)

      const putRes = await handleGithubPublishRoutes(
        settingsRequest('PUT', cookie, {
          repoUrl: TEST_REPO,
          branch: 'gh-pages',
          basePath: '/instatic-dite',
          token: TEST_TOKEN,
        }),
        db,
      )
      expect(putRes?.status).toBe(200)

      const res = await handleGithubPublishRoutes(
        pushPackageRequest(cookie, { embedToken: true }),
        db,
        { uploadsDir },
      )
      expect(res?.status).toBe(200)
      expect(res!.headers.get('content-type')).toBe('application/zip')
      expect(res!.headers.get('content-disposition')).toContain('instatic-push-kit.zip')

      const body = new Uint8Array(await res!.arrayBuffer())
      // ZIP magic: PK\x03\x04 (local file header).
      expect([...body.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
      // The embedded token never appears verbatim in the ZIP? It DOES — the
      // scripts embed it by design. The ZIP is the credential; that is the
      // documented trade-off. Only assert the kit is non-trivial.
      expect(body.byteLength).toBeGreaterThan(200)
    } finally {
      await safeCleanup(cleanup)
    }
  })
})
