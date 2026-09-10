/**
 * gitCliPush — end-to-end against a real local bare repository (no network,
 * no GitHub). Skipped entirely when the git binary is unavailable (e.g.
 * minimal CI images); the Docker runtime image installs git explicitly.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitCliPush } from '../../../server/github/gitCliPush'
import type { GitPushProgress } from '../../../server/github/types'

const GIT_AVAILABLE = Bun.which('git') !== null
const TOKEN = 'ghp_test_token_do_not_log'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(' ')} exit=${code} stdout=${stdout} stderr=${stderr}`)
  return stdout.trim()
}

/** Bare remote with a single seeded commit on `branch`; returns its path. */
async function makeBareRemote(branch: string, files: Record<string, string> = {}): Promise<string> {
  const bare = await makeTempDir('instatic-gh-git-remote-')
  await git(bare, 'init', '--bare', '-b', branch, '.')
  const seed = await makeTempDir('instatic-gh-git-seed-')
  await git(seed, 'init', '-b', branch, '.')
  await git(seed, 'config', 'user.email', 'seed@test')
  await git(seed, 'config', 'user.name', 'seed')
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(seed, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content)
  }
  await git(seed, 'add', '-A')
  await git(seed, 'commit', '--allow-empty', '-m', 'seed')
  await git(seed, 'push', bare, branch)
  return bare
}

function bareFile(bare: string, branch: string, relPath: string): Promise<string> {
  return git(bare, '--git-dir', bare, 'show', `${branch}:${relPath}`)
}

async function bareFileList(bare: string, branch: string): Promise<string[]> {
  const out = await git(bare, '--git-dir', bare, 'ls-tree', '-r', '--name-only', branch)
  return out === '' ? [] : out.split('\n')
}

async function bareCommitCount(bare: string, branch: string): Promise<number> {
  return Number(await git(bare, '--git-dir', bare, 'rev-list', '--count', branch))
}

function pushInput(over: Partial<Parameters<typeof gitCliPush>[0]>): Parameters<typeof gitCliPush>[0] {
  return {
    token: TOKEN,
    owner: 'acme',
    repo: 'site',
    branch: 'gh-pages',
    targetDir: '',
    exportDir: '',
    workDir: '',
    ...over,
  }
}

describe('gitCliPush', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  test('full replace: bare remote ends up with exactly the export files', async () => {
    const bare = await makeBareRemote('gh-pages', { 'stale.html': 'old' })
    const exportDir = await makeTempDir('instatic-gh-git-export-')
    await writeFile(join(exportDir, 'index.html'), '<html>new</html>')
    const workDir = await makeTempDir('instatic-gh-git-work-')

    const result = await gitCliPush(
      pushInput({ exportDir, workDir, remoteBaseUrl: bare }),
    )

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(await bareFileList(bare, 'gh-pages')).toEqual(['.nojekyll', 'index.html'])
    expect(await bareFile(bare, 'gh-pages', 'index.html')).toBe('<html>new</html>')
  }, 20_000)

  test('the clone never stores the PAT: .git/config remote is credential-free', async () => {
    const bare = await makeBareRemote('gh-pages')
    const exportDir = await makeTempDir('instatic-gh-git-export-')
    await writeFile(join(exportDir, 'index.html'), 'x')
    const workDir = await makeTempDir('instatic-gh-git-work-')

    await gitCliPush(pushInput({ exportDir, workDir, remoteBaseUrl: bare }))

    const stored = await git(workDir, 'remote', 'get-url', 'origin')
    expect(stored).not.toContain(TOKEN)
    expect(stored).toBe(bare)
  }, 20_000)

  test('second push reuses the workspace: incremental, no re-clone artifacts', async () => {
    const bare = await makeBareRemote('gh-pages')
    const exportDir = await makeTempDir('instatic-gh-git-export-')
    const workDir = await makeTempDir('instatic-gh-git-work-')

    await writeFile(join(exportDir, 'a.html'), 'A')
    const first = await gitCliPush(pushInput({ exportDir, workDir, remoteBaseUrl: bare }))

    await writeFile(join(exportDir, 'b.html'), 'B')
    const second = await gitCliPush(pushInput({ exportDir, workDir, remoteBaseUrl: bare }))

    expect(second.commitSha).not.toBe(first.commitSha)
    expect(await bareFileList(bare, 'gh-pages')).toEqual(['.nojekyll', 'a.html', 'b.html'])
    // Workspace persisted — exactly the two pushes, no reset commits.
    expect(await bareCommitCount(bare, 'gh-pages')).toBe(3) // seed + 2
  }, 20_000)

  test('targetDir scope: siblings outside the prefix survive', async () => {
    const bare = await makeBareRemote('gh-pages', { 'keep.txt': 'keep' })
    const exportDir = await makeTempDir('instatic-gh-git-export-')
    await writeFile(join(exportDir, 'new.html'), 'new')
    const workDir = await makeTempDir('instatic-gh-git-work-')

    await gitCliPush(pushInput({ exportDir, workDir, remoteBaseUrl: bare, targetDir: 'docs' }))

    expect(await bareFileList(bare, 'gh-pages')).toEqual(['.nojekyll', 'docs/new.html', 'keep.txt'])
  }, 20_000)

  test('unchanged export: no empty commit, existing tip returned', async () => {
    const bare = await makeBareRemote('gh-pages')
    const exportDir = await makeTempDir('instatic-gh-git-export-')
    await writeFile(join(exportDir, 'index.html'), 'same')
    const workDir = await makeTempDir('instatic-gh-git-work-')

    const first = await gitCliPush(pushInput({ exportDir, workDir, remoteBaseUrl: bare }))
    const second = await gitCliPush(pushInput({ exportDir, workDir, remoteBaseUrl: bare }))

    expect(second.commitSha).toBe(first.commitSha)
    expect(await bareCommitCount(bare, 'gh-pages')).toBe(2) // seed + 1
  }, 20_000)

  test('missing branch: operator-facing error', async () => {
    const bare = await makeBareRemote('main')
    const exportDir = await makeTempDir('instatic-gh-git-export-')
    await writeFile(join(exportDir, 'index.html'), 'x')
    const workDir = await makeTempDir('instatic-gh-git-work-')

    await expect(
      gitCliPush(pushInput({ exportDir, workDir, remoteBaseUrl: bare, branch: 'gh-pages' })),
    ).rejects.toThrow(/Branch does not exist: gh-pages/)
  }, 20_000)

  test('self-heal: broken workspace is wiped and the push still succeeds', async () => {
    const bare = await makeBareRemote('gh-pages')
    const exportDir = await makeTempDir('instatic-gh-git-export-')
    await writeFile(join(exportDir, 'index.html'), 'healed')
    const workDir = await makeTempDir('instatic-gh-git-work-')
    // Corrupt the workspace: not a git repo at all.
    await writeFile(join(workDir, 'garbage.txt'), 'junk')

    const result = await gitCliPush(pushInput({ exportDir, workDir, remoteBaseUrl: bare }))

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/)
    expect(await bareFileList(bare, 'gh-pages')).toEqual(['.nojekyll', 'index.html'])
  }, 20_000)

  test('repo switch in settings: stale workspace pointing elsewhere is re-bootstrapped', async () => {
    const first = await makeBareRemote('gh-pages')
    const second = await makeBareRemote('gh-pages')
    const exportDir = await makeTempDir('instatic-gh-git-export-')
    await writeFile(join(exportDir, 'index.html'), 'moved')
    const workDir = await makeTempDir('instatic-gh-git-work-')

    await gitCliPush(pushInput({ exportDir, workDir, remoteBaseUrl: first }))
    await gitCliPush(pushInput({ exportDir, workDir, remoteBaseUrl: second }))

    expect(await bareFileList(second, 'gh-pages')).toEqual(['.nojekyll', 'index.html'])
  }, 20_000)

  test('progress events cover uploading and finalizing phases', async () => {
    const bare = await makeBareRemote('gh-pages')
    const exportDir = await makeTempDir('instatic-gh-git-export-')
    await writeFile(join(exportDir, 'index.html'), 'x')
    const workDir = await makeTempDir('instatic-gh-git-work-')

    const events: GitPushProgress[] = []
    await gitCliPush(
      pushInput({ exportDir, workDir, remoteBaseUrl: bare, onProgress: (p) => events.push(p) }),
    )

    expect(events[0]).toEqual({ phase: 'uploading', uploaded: 0, total: 1, currentPath: '' })
    expect(events.at(-1)?.phase).toBe('finalizing')
    expect(events.at(-1)?.uploaded).toBe(1)
  }, 20_000)
})
