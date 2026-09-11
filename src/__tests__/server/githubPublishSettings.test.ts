/**
 * GitHub publish settings — repository-level tests against a real SQLite DB
 * (migrations applied), covering encrypt-at-rest for the PAT and the wire-safe
 * view projection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import {
  decryptGithubPublishToken,
  getGithubPublishSettingsView,
  GithubPublishSettingsError,
  upsertGithubPublishSettings,
} from '../../../server/repositories/githubPublishSettings'
import { __resetMasterKeyCacheForTesting } from '../../../server/secrets/masterKey'

const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
const TEST_TOKEN = 'ghp_test_secret_value'
const TEST_REPO = 'https://github.com/acme/my-site'

/** Windows often keeps the SQLite handle open through afterEach; ignore EBUSY. */
async function safeCleanup(cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EBUSY') throw err
  }
}

describe('github publish settings repository', () => {
  let testDb: TestDb
  let originalSecretKey: string | undefined

  beforeEach(async () => {
    originalSecretKey = process.env.INSTATIC_SECRET_KEY
    process.env.INSTATIC_SECRET_KEY = TEST_MASTER_KEY
    __resetMasterKeyCacheForTesting()
    testDb = await createTestDb()
  })

  afterEach(async () => {
    if (originalSecretKey === undefined) delete process.env.INSTATIC_SECRET_KEY
    else process.env.INSTATIC_SECRET_KEY = originalSecretKey
    __resetMasterKeyCacheForTesting()
    await safeCleanup(() => testDb.cleanup())
  })

  it('returns empty defaults when no row exists', async () => {
    const view = await getGithubPublishSettingsView(testDb.db)
    expect(view).toEqual({
      repoUrl: '',
      owner: '',
      repo: '',
      branch: 'gh-pages',
      targetDir: '',
      basePath: '',
      workdir: '',
      hasToken: false,
      keyFingerprintCurrent: true,
      updatedAt: null,
    })
  })

  it('stores an encrypted token and never exposes plaintext on the view', async () => {
    const view = await upsertGithubPublishSettings(testDb.db, {
      workdir: '',
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      targetDir: 'docs',
      basePath: '/my-site',
      token: TEST_TOKEN,
    })

    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain(TEST_TOKEN)
    expect(view.hasToken).toBe(true)
    expect(view.repoUrl).toBe('https://github.com/acme/my-site')
    expect(view.owner).toBe('acme')
    expect(view.repo).toBe('my-site')
    expect(view.branch).toBe('gh-pages')
    expect(view.targetDir).toBe('docs')
    expect(view.basePath).toBe('/my-site')
    expect(view.keyFingerprintCurrent).toBe(true)
    expect(view.updatedAt).not.toBeNull()
    expect(Object.hasOwn(view, 'ciphertext')).toBe(false)
    expect(Object.hasOwn(view, 'token')).toBe(false)
    expect(Object.hasOwn(view, 'tokenCiphertext')).toBe(false)
    expect(Object.hasOwn(view, 'iv')).toBe(false)
  })

  it('preserves the token when omitted on a subsequent upsert', async () => {
    await upsertGithubPublishSettings(testDb.db, {
      workdir: '',
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      targetDir: '',
      basePath: '',
      token: TEST_TOKEN,
    })

    const view = await upsertGithubPublishSettings(testDb.db, {
      workdir: '',
      repoUrl: TEST_REPO,
      branch: 'main',
      targetDir: 'public',
      basePath: '/repo',
    })

    expect(view.hasToken).toBe(true)
    expect(view.branch).toBe('main')
    expect(view.targetDir).toBe('public')
    expect(await decryptGithubPublishToken(testDb.db)).toBe(TEST_TOKEN)
  })

  it('trims whitespace pasted around the token and other settings strings', async () => {
    await upsertGithubPublishSettings(testDb.db, {
      workdir: '',
      repoUrl: TEST_REPO,
      branch: '  gh-pages\n',
      targetDir: 'docs',
      basePath: ' /my-site ',
      token: `  ${TEST_TOKEN}\n`,
    })
    const decrypted = await decryptGithubPublishToken(testDb.db)
    expect(decrypted).toBe(TEST_TOKEN)
    const view = await getGithubPublishSettingsView(testDb.db)
    expect(view.branch).toBe('gh-pages')
    expect(view.basePath).toBe('/my-site')
  })

  it("clears the token when upsert receives token: ''", async () => {
    await upsertGithubPublishSettings(testDb.db, {
      workdir: '',
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      targetDir: '',
      basePath: '',
      token: TEST_TOKEN,
    })

    const view = await upsertGithubPublishSettings(testDb.db, {
      workdir: '',
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      targetDir: '',
      basePath: '',
      token: '',
    })

    expect(view.hasToken).toBe(false)
    expect(await decryptGithubPublishToken(testDb.db)).toBeNull()
  })

  it('decryptGithubPublishToken returns plaintext when a token is stored', async () => {
    await upsertGithubPublishSettings(testDb.db, {
      workdir: '',
      repoUrl: TEST_REPO,
      branch: 'gh-pages',
      targetDir: '',
      basePath: '',
      token: TEST_TOKEN,
    })

    expect(await decryptGithubPublishToken(testDb.db)).toBe(TEST_TOKEN)
  })

  it('rejects targetDir containing ..', async () => {
    await expect(
      upsertGithubPublishSettings(testDb.db, {
      workdir: '',
        repoUrl: TEST_REPO,
        branch: 'gh-pages',
        targetDir: '../escape',
        basePath: '',
      }),
    ).rejects.toMatchObject({
      name: 'GithubPublishSettingsError',
      status: 400,
    } satisfies Partial<GithubPublishSettingsError>)
  })
})
