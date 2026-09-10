/**
 * Local push kit builder — the ZIP deliverable that replaces the server-side
 * Git Data API push. Covers: kit layout (site/ + .nojekyll + push.cmd +
 * push.sh + README.txt), token embedding (and its absence), basePath
 * propagation into the export, and error mapping.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import {
  buildLocalPushKit,
  LocalPushKitError,
} from '../../../server/publish/localPushKit'
import { StaticExportError } from '@core/static-export/buildExportTree'
import { prepareInactiveSlot, swapSlot, writeArtefact } from '../../../server/publish/staticArtefact'
import { upsertGithubPublishSettings } from '../../../server/repositories/githubPublishSettings'
import { __resetMasterKeyCacheForTesting } from '../../../server/secrets/masterKey'

const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
const TEST_TOKEN = 'ghp_test_secret_value'
const TEST_REPO = 'https://github.com/mateng-cb/instatic-dite'

const PAGE_HTML = (mediaName: string) =>
  `<!DOCTYPE html><html><body><img src="/uploads/${mediaName}" alt=""></body></html>`

/** Windows may keep the SQLite handle open briefly after the test ends. */
async function safeCleanup(cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EBUSY') throw err
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('buildLocalPushKit', () => {
  let testDb: TestDb
  let originalSecretKey: string | undefined
  let uploadsDir: string
  let kitDir: string
  const tempDirs: string[] = []

  beforeEach(async () => {
    originalSecretKey = process.env.INSTATIC_SECRET_KEY
    process.env.INSTATIC_SECRET_KEY = TEST_MASTER_KEY
    __resetMasterKeyCacheForTesting()
    testDb = await createTestDb()
    uploadsDir = await mkdtemp(join(tmpdir(), 'push-kit-uploads-'))
    kitDir = await mkdtemp(join(tmpdir(), 'push-kit-'))
    tempDirs.push(uploadsDir, kitDir)

    // A published one-page site with one media asset, referenced from HTML.
    await writeFile(join(uploadsDir, 'hero.png'), new Uint8Array([137, 80, 78, 71, 9]))
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/', PAGE_HTML('hero.png'))
    await swapSlot(uploadsDir, slot)
  })

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    if (originalSecretKey === undefined) delete process.env.INSTATIC_SECRET_KEY
    else process.env.INSTATIC_SECRET_KEY = originalSecretKey
    __resetMasterKeyCacheForTesting()
    await safeCleanup(() => testDb.cleanup())
  })

  it('fails with a 400-shaped error when no repository is configured', async () => {
    let caught: unknown
    try {
      await buildLocalPushKit({ db: testDb.db, uploadsDir, kitDir, embedToken: false })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LocalPushKitError)
    expect((caught as LocalPushKitError).status).toBe(400)
  })

  it('fails with a 400-shaped error when embedding but no usable token is stored', async () => {
    await upsertGithubPublishSettings(testDb.db, {
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      basePath: '/instatic-dite',
    })

    let caught: unknown
    try {
      await buildLocalPushKit({ db: testDb.db, uploadsDir, kitDir, embedToken: true })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(LocalPushKitError)
    expect((caught as LocalPushKitError).status).toBe(400)
  })

  it('propagates StaticExportError when the site is not published', async () => {
    await upsertGithubPublishSettings(testDb.db, {
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      basePath: '',
    })
    const emptyUploads = await mkdtemp(join(tmpdir(), 'push-kit-empty-'))
    tempDirs.push(emptyUploads)

    let caught: unknown
    try {
      await buildLocalPushKit({ db: testDb.db, uploadsDir: emptyUploads, kitDir, embedToken: false })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(StaticExportError)
    expect((caught as StaticExportError).code).toBe('not-published')
  })

  it('builds a kit without embedded token: clean remote URL, .nojekyll, README', async () => {
    await upsertGithubPublishSettings(testDb.db, {
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      basePath: '/instatic-dite',
      token: TEST_TOKEN,
    })

    const result = await buildLocalPushKit({
      db: testDb.db,
      uploadsDir,
      kitDir,
      embedToken: false,
    })

    expect(result.tokenEmbedded).toBe(false)
    expect(result.repoUrl).toBe(TEST_REPO)
    expect(result.branch).toBe('gh-pages')
    expect(result.pageCount).toBe(1)

    // Export landed under site/ with basePath-rewritten asset URLs.
    const html = await readFile(join(kitDir, 'site', 'index.html'), 'utf8')
    expect(html).toContain('src="/instatic-dite/uploads/hero.png"')
    expect(await fileExists(join(kitDir, 'site', 'uploads', 'hero.png'))).toBe(true)
    // Jekyll guard for `_instatic/` assets.
    expect(await fileExists(join(kitDir, 'site', '.nojekyll'))).toBe(true)

    // Scripts carry the clean remote URL and the configured branch.
    const cmd = await readFile(join(kitDir, 'push.cmd'), 'utf8')
    expect(cmd).toContain('git remote add origin https://github.com/mateng-cb/instatic-dite.git')
    expect(cmd).toContain('git push -f origin gh-pages')
    expect(cmd).not.toContain(TEST_TOKEN)
    // .cmd files must be CRLF so the Windows parser reads them reliably.
    expect(cmd).toContain('\r\n')

    const sh = await readFile(join(kitDir, 'push.sh'), 'utf8')
    expect(sh).toContain('https://github.com/mateng-cb/instatic-dite.git')
    expect(sh).not.toContain(TEST_TOKEN)

    const readme = await readFile(join(kitDir, 'README.txt'), 'utf8')
    expect(readme).toContain('https://github.com/mateng-cb/instatic-dite')
    expect(readme).toContain('gh-pages')
    expect(readme).not.toContain(TEST_TOKEN)
    expect(readme).toContain('未内嵌凭证')
  })

  it('builds a kit with the stored token embedded into the push remote URL', async () => {
    await upsertGithubPublishSettings(testDb.db, {
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      basePath: '/instatic-dite',
      token: TEST_TOKEN,
    })

    const result = await buildLocalPushKit({
      db: testDb.db,
      uploadsDir,
      kitDir,
      embedToken: true,
    })

    expect(result.tokenEmbedded).toBe(true)

    const expectedRemote = `https://${TEST_TOKEN}@github.com/mateng-cb/instatic-dite.git`
    const cmd = await readFile(join(kitDir, 'push.cmd'), 'utf8')
    expect(cmd).toContain(`git remote add origin ${expectedRemote}`)
    // The script strips the remote (token included) after the push.
    expect(cmd.match(/git remote remove origin/g)?.length).toBe(3)

    const sh = await readFile(join(kitDir, 'push.sh'), 'utf8')
    expect(sh).toContain(expectedRemote)

    const readme = await readFile(join(kitDir, 'README.txt'), 'utf8')
    expect(readme).not.toContain(TEST_TOKEN)
    expect(readme).toContain('内嵌了仓库访问凭证')
  })
})
