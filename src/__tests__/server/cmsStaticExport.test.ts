/**
 * Integration tests — POST /admin/api/cms/export-static
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbClient } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { handleStaticExportRoutes } from '../../../server/handlers/cms/staticExport'
import {
  prepareInactiveSlot,
  swapSlot,
  writeArtefact,
} from '../../../server/publish/staticArtefact'
import { SESSION_COOKIE_NAME } from '../../../server/auth/tokens'
import { stampSocketIp } from '../../../server/auth/security'
import { createTestDb } from '../helpers/createTestDb'

const VALID_LOGIN_PHRASE = 'long-enough-phrase'
const EMAIL = 'owner@example.com'
const IP = '203.0.113.10'

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
      body: JSON.stringify({ siteName: 'Static Export Test', email: EMAIL, password: VALID_LOGIN_PHRASE }),
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

/**
 * Step-up rotates the session cookie via Set-Cookie. Callers must use the
 * returned cookie for subsequent gated requests.
 */
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

function exportStaticRequest(cookie?: string, body: unknown = { pathMode: 'relative' }): Request {
  const req = new Request('http://localhost/admin/api/cms/export-static', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (cookie) withCookie(req, cookie)
  return req
}

async function seedPublishedHomepage(uploadsDir: string): Promise<void> {
  const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
  await writeArtefact(
    slotDir,
    '/',
    '<!DOCTYPE html><html><head><title>Home</title></head><body><h1>Hello static export</h1></body></html>',
  )
  await swapSlot(uploadsDir, slot)
}

describe('POST /admin/api/cms/export-static', () => {
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'cms-static-export-'))
  })

  afterEach(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('returns 401 when unauthenticated', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const res = await handleStaticExportRoutes(exportStaticRequest(), db, { uploadsDir })
      expect(res?.status).toBe(401)
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('returns 403 when authenticated but missing pages.publish capability', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      // roles.manage / users.manage mutations also require step-up.
      const ownerCookie = await completeStepUp(db, await login(db))

      const memberRoleReq = new Request('http://localhost/admin/api/cms/roles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: 'viewer-only',
          name: 'Viewer Only',
          description: '',
          capabilities: ['site.read'],
        }),
      })
      withCookie(memberRoleReq, ownerCookie)
      const memberRoleRes = await handleCmsRequest(memberRoleReq, db)
      expect(memberRoleRes.status).toBe(201)
      const memberRole = await memberRoleRes.json() as { role: { id: string } }

      const createUserReq = new Request('http://localhost/admin/api/cms/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'viewer@example.com',
          displayName: 'Viewer',
          password: VALID_LOGIN_PHRASE,
          roleId: memberRole.role.id,
        }),
      })
      withCookie(createUserReq, ownerCookie)
      const createUserRes = await handleCmsRequest(createUserReq, db)
      expect(createUserRes.status).toBe(201)

      const loginReq = new Request('http://localhost/admin/api/cms/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'viewer@example.com', password: VALID_LOGIN_PHRASE }),
      })
      stampSocketIp(loginReq, IP)
      const loginRes = await handleCmsRequest(loginReq, db)
      expect(loginRes.status).toBe(200)
      const cookie = cookieFromSetCookie(loginRes)

      const res = await handleStaticExportRoutes(exportStaticRequest(cookie), db, { uploadsDir })
      expect(res?.status).toBe(403)
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('returns 409 when the site has not been published', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await completeStepUp(db, await login(db))

      const res = await handleStaticExportRoutes(exportStaticRequest(cookie), db, { uploadsDir })
      expect(res?.status).toBe(409)
      const body = await res!.json() as { error: string }
      expect(body.error).toBe('Site has not been published yet.')
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('returns 400 when pathMode is basePath without basePath', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await completeStepUp(db, await login(db))
      await seedPublishedHomepage(uploadsDir)

      const res = await handleStaticExportRoutes(
        exportStaticRequest(cookie, { pathMode: 'basePath' }),
        db,
        { uploadsDir },
      )
      expect(res?.status).toBe(400)
    } finally {
      await safeCleanup(cleanup)
    }
  })

  it('returns 200 zip for a published static homepage', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await setup(db)
      const cookie = await completeStepUp(db, await login(db))
      await seedPublishedHomepage(uploadsDir)

      const res = await handleStaticExportRoutes(exportStaticRequest(cookie), db, { uploadsDir })
      expect(res?.status).toBe(200)
      expect(res?.headers.get('content-type')).toBe('application/zip')
      expect(res?.headers.get('content-disposition')).toContain('instatic-static-export.zip')

      const bytes = new Uint8Array(await res!.arrayBuffer())
      expect(bytes[0]).toBe(0x50)
      expect(bytes[1]).toBe(0x4b)
    } finally {
      await safeCleanup(cleanup)
    }
  })
})
