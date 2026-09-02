/**
 * Integration tests — GitHub publish settings + POST /publish-github auth/shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { handleGithubPublishRoutes } from '../../../server/handlers/cms/githubPublish'
import { SESSION_COOKIE_NAME } from '../../../server/auth/tokens'
import { stampSocketIp } from '../../../server/auth/security'
import { __resetMasterKeyCacheForTesting } from '../../../server/secrets/masterKey'
import { createTestDb } from '../helpers/createTestDb'

const VALID_LOGIN_PHRASE = 'long-enough-phrase'
const EMAIL = 'owner@example.com'
const IP = '203.0.113.10'
const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
const TEST_TOKEN = 'ghp_test_secret_value_for_handlers'
const TEST_REPO = 'https://github.com/acme/my-site'

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
      body: JSON.stringify({ siteName: 'GitHub Publish Test', email: EMAIL, password: VALID_LOGIN_PHRASE }),
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

function withCookie(req: Request, cookie: string): Request {
  req.headers.set('cookie', cookie)
  return req
}

async function completeStepUp(db: DbClient, cookie: string): Promise<string> {
  const req = new Request('http://localhost/admin/api/cms/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: VALID_LOGIN_PHRASE }),
  })
  stampSocketIp(req, IP)
  withCookie(req, cookie)
  const res = await handleCmsRequest(req, db)
  expect(res.status).toBe(200)
  return cookieFromSetCookie(res)
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

function publishGithubRequest(cookie?: string, body: unknown = {}): Request {
  const req = new Request('http://localhost/admin/api/cms/publish-github', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (cookie) withCookie(req, cookie)
  return req
}

describe('GitHub publish HTTP handlers', () => {
  let originalSecretKey: string | undefined

  beforeEach(() => {
    originalSecretKey = process.env.INSTATIC_SECRET_KEY
    process.env.INSTATIC_SECRET_KEY = TEST_MASTER_KEY
    __resetMasterKeyCacheForTesting()
  })

  afterEach(() => {
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
      // Settings do not require step-up — login cookie is enough.
      const cookie = await login(db)

      const emptyRes = await handleGithubPublishRoutes(settingsRequest('GET', cookie), db)
      expect(emptyRes?.status).toBe(200)
      const emptyBody = await emptyRes!.json() as Record<string, unknown>
      expect(emptyBody.hasToken).toBe(false)
      expect(Object.hasOwn(emptyBody, 'token')).toBe(false)
      expect(Object.hasOwn(emptyBody, 'tokenCiphertext')).toBe(false)
      expect(JSON.stringify(emptyBody)).not.toContain(TEST_TOKEN)

      const putRes = await handleGithubPublishRoutes(
        settingsRequest('PUT', cookie, {
          repoUrl: TEST_REPO,
          branch: 'gh-pages',
          targetDir: 'docs',
          basePath: '/my-site',
          token: TEST_TOKEN,
        }),
        db,
      )
      expect(putRes?.status).toBe(200)
      const putBody = await putRes!.json() as Record<string, unknown>
      expect(putBody.hasToken).toBe(true)
      expect(putBody.repoUrl).toBe('https://github.com/acme/my-site')
      expect(putBody.owner).toBe('acme')
      expect(putBody.repo).toBe('my-site')
      expect(Object.hasOwn(putBody, 'token')).toBe(false)
      expect(JSON.stringify(putBody)).not.toContain(TEST_TOKEN)

      const getRes = await handleGithubPublishRoutes(settingsRequest('GET', cookie), db)
      expect(getRes?.status).toBe(200)
      const getBody = await getRes!.json() as Record<string, unknown>
      expect(getBody.hasToken).toBe(true)
      expect(Object.hasOwn(getBody, 'token')).toBe(false)
      expect(JSON.stringify(getBody)).not.toContain(TEST_TOKEN)
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('PUT settings returns 400 for an invalid repo URL', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await login(db)

      const res = await handleGithubPublishRoutes(
        settingsRequest('PUT', cookie, {
          repoUrl: 'https://gitlab.com/acme/my-site',
          branch: 'gh-pages',
          targetDir: '',
          basePath: '',
        }),
        db,
      )
      expect(res?.status).toBe(400)
      const body = await res!.json() as { error: string }
      expect(body.error.length).toBeGreaterThan(0)
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('POST publish-github requires step-up after pages.publish', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await login(db)

      const needsStepUp = await handleGithubPublishRoutes(
        publishGithubRequest(cookie),
        db,
        { uploadsDir: '/tmp/unused' },
      )
      expect(needsStepUp?.status).toBe(401)
      const stepUpBody = await needsStepUp!.json() as { error: string }
      expect(stepUpBody.error).toBe('step_up_required')
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('POST publish-github returns 400 when token is missing after step-up', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await completeStepUp(db, await login(db))

      // Persist repo without a token so the orchestrator fails on token-missing.
      const putRes = await handleGithubPublishRoutes(
        settingsRequest('PUT', cookie, {
          repoUrl: TEST_REPO,
          branch: 'gh-pages',
          targetDir: '',
          basePath: '',
        }),
        db,
      )
      expect(putRes?.status).toBe(200)

      const res = await handleGithubPublishRoutes(
        publishGithubRequest(cookie),
        db,
        { uploadsDir: '/tmp/unused' },
      )
      expect(res?.status).toBe(400)
      const body = await res!.json() as { error: string }
      expect(body.error).toMatch(/token/i)
    } finally {
      await safeCleanup(cleanup)
    }
  })
})
