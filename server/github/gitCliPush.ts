/**
 * Push a Phase A static-export directory to GitHub with the real git CLI.
 * No REST API calls — no 5000 req/h quota, no per-file uploads; git
 * negotiates an incremental pack on push.
 *
 * Workspace shape: one **persistent working clone** at `input.workDir`,
 * bootstrapped on first use and self-healed on any git failure:
 * a failed step (stale index.lock, rejected non-fast-forward, corrupted
 * clone, repo/branch switch in settings) wipes the workdir and replays the
 * whole push once from a fresh clone. Concurrency is not a concern here —
 * the publish job registry is single-slot, so pushes are serialized.
 *
 * Tree semantics (unchanged from the previous API push):
 * - `targetDir === ''` → the worktree is wiped (except `.git`); the export
 *   files become the whole tree (full tip replace).
 * - non-empty `targetDir` → only that prefix is wiped; export files land at
 *   `targetDir/{relPath}`, siblings are untouched.
 */

import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitPushInput, GitPushProgress, GitPushResult } from './types'
import { normalizeTargetDir, walkExportFiles } from './gitCliPushInternals'

export type { GitPushInput, GitPushProgress, GitPushResult } from './types'

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
/**
 * Clone and push move the whole site over the wire — a real shallow clone of
 * a mature site repo takes minutes (measured 3m37s for 4132 files on a slow
 * link), far past the short-command budget. They get their own, generous one.
 */
const LONG_COMMAND_TIMEOUT_MS = 600_000
const DEFAULT_COMMIT_MESSAGE = 'Publish site from Instatic'

export class GitPushError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GitPushError'
  }
}

type RunOpts = {
  timeoutMs: number
  token?: string
  cwd?: string
}

/** Run one git command; non-zero exit becomes a GitPushError with a scrubbed message. */
async function runGit(args: string[], opts: RunOpts): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: opts.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // Kill hung commands; a wedged clone/push must not hold the job forever.
    timeout: opts.timeoutMs,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    let message = gitFailureMessage(args[0] ?? 'git', code, stderr, opts.token)
    // SIGTERM (143 on Windows / -15 as a signal) is how Bun.spawn's timeout
    // kills a command; without this hint git's last words ("fatal: early
    // EOF" from a half-transfer) read like a network fault, not a timeout.
    if (code === 143 || code === -15) {
      message += ` — killed after exceeding the ${opts.timeoutMs}ms command timeout`
    }
    throw new GitPushError(message)
  }
  return stdout
}

/** git error text — scrubbed of the token and trimmed to what an operator needs. */
function gitFailureMessage(command: string, exitCode: number, stderr: string, token?: string): string {
  let detail = stderr.trim()
  if (token) {
    detail = detail
      .replaceAll(token, '<redacted>')
      .replaceAll(encodeURIComponent(token), '<redacted>')
      .replaceAll(token.replace(/^ghp_/, ''), '<redacted>')
  }
  return `git ${command} failed (exit ${exitCode})${detail ? `: ${detail.slice(0, 500)}` : ''}`
}

/** Credentials ride the URL for HTTPS PAT auth; scrubbed from all error output. */
function remoteUrl(input: GitPushInput): string {
  const base = input.remoteBaseUrl ?? `https://github.com/${input.owner}/${input.repo}.git`
  return base.replace('https://', `https://x-access-token:${input.token}@`)
}

/** Token-free URL stored in .git/config — the PAT never persists on disk. */
function neutralRemote(input: GitPushInput): string {
  return input.remoteBaseUrl ?? `https://github.com/${input.owner}/${input.repo}.git`
}

/**
 * Clone with the tokened URL (private repos 404 on an anonymous clone), then
 * rewrite origin to the neutral URL so no credential persists in .git/config.
 * Pushes go to the tokened URL per publish. Both must see the same repo, so
 * `workspaceMatches` can compare the stored remote against `neutralRemote` to
 * detect a repo/branch switch in settings.
 */
async function cloneWorkspace(
  input: GitPushInput,
  neutralUrl: string,
  shortTimeoutMs: number,
  longTimeoutMs: number,
): Promise<void> {
  await rm(input.workDir, { recursive: true, force: true })
  // Create the whole workDir chain in one recursive call. Joining '..' would
  // degrade to mkdir('.') for a single-segment relative workDir, and Bun on
  // Windows throws EEXIST for that even with recursive — a git clone into a
  // pre-created empty directory is fine.
  await mkdir(input.workDir, { recursive: true })
  // Language-independent branch existence check: localized git error text
  // ("Remote branch … not found" / 致命错误：…未发现) is not matchable.
  const remoteHeads = await runGit(['ls-remote', '--heads', remoteUrl(input), input.branch], {
    timeoutMs: shortTimeoutMs, token: input.token,
  })
  if (remoteHeads.trim() === '') {
    throw new GitPushError(
      `Branch does not exist: ${input.branch}. Create the branch on GitHub before publishing.`,
    )
  }
  try {
    await runGit(
      ['clone', '--depth', '1', '--no-tags', '--branch', input.branch, remoteUrl(input), input.workDir],
      { timeoutMs: longTimeoutMs, token: input.token },
    )
    await runGit(['remote', 'set-url', 'origin', neutralUrl], {
      timeoutMs: shortTimeoutMs, cwd: input.workDir,
    })
  } catch (err) {
    await rm(input.workDir, { recursive: true, force: true })
    throw err
  }
}

/**
 * The workspace is stale when it is not a clone of the configured repo on the
 * configured branch (settings changed underneath us, or the directory is junk).
 */
async function workspaceMatches(
  input: GitPushInput,
  expectedRemote: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const remote = await runGit(['remote', 'get-url', 'origin'], {
      timeoutMs, cwd: input.workDir,
    })
    if (remote.trim() !== expectedRemote) return false
    const head = await runGit(
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${input.branch}`],
      { timeoutMs, cwd: input.workDir },
    )
    return head.trim() !== ''
  } catch (_err) {
    // Expected for a junk/absent workspace — that is exactly what we detect.
    return false
  }
}

/** Wipe the replaced scope (never `.git`), copy the export in, report progress. */
async function syncExportFiles(
  input: GitPushInput,
  targetDir: string,
  onProgress?: (p: GitPushProgress) => void,
): Promise<number> {
  if (targetDir === '') {
    for (const entry of await readdir(input.workDir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      await rm(join(input.workDir, entry.name), { recursive: true, force: true })
    }
  } else {
    await rm(join(input.workDir, targetDir), { recursive: true, force: true })
  }

  const files = await walkExportFiles(input.exportDir)
  onProgress?.({ phase: 'uploading', uploaded: 0, total: files.length, currentPath: '' })

  let uploaded = 0
  for (const file of files) {
    const dest = targetDir === ''
      ? join(input.workDir, file.relPath)
      : join(input.workDir, targetDir, file.relPath)
    await Bun.write(dest, Bun.file(file.absPath))
    uploaded += 1
    onProgress?.({
      phase: 'uploading',
      uploaded,
      total: files.length,
      currentPath: targetDir === '' ? file.relPath : `${targetDir}/${file.relPath}`,
    })
  }
  // GitHub Pages needs this at the repo root to serve `_`-prefixed assets
  // (`_instatic/` holes) without Jekyll processing. Cheap to rewrite every push.
  await Bun.write(join(input.workDir, '.nojekyll'), '')
  return files.length
}

async function commitAndPush(
  input: GitPushInput,
  shortTimeoutMs: number,
  longTimeoutMs: number,
): Promise<GitPushResult> {
  await runGit(['add', '-A'], { timeoutMs: shortTimeoutMs, cwd: input.workDir })

  const status = await runGit(['status', '--porcelain'], { timeoutMs: shortTimeoutMs, cwd: input.workDir })
  let commitSha: string
  if (status.trim() === '') {
    // Nothing changed since the last publish — report the existing tip
    // instead of manufacturing an empty commit.
    commitSha = (await runGit(['rev-parse', 'HEAD'], { timeoutMs: shortTimeoutMs, cwd: input.workDir })).trim()
  } else {
    await runGit(
      [
        '-c', 'user.name=Instatic',
        '-c', 'user.email=publish@instatic.local',
        'commit', '-m', input.commitMessage ?? DEFAULT_COMMIT_MESSAGE,
      ],
      { timeoutMs: shortTimeoutMs, cwd: input.workDir },
    )
    // Push to the tokened URL explicitly — origin stays credential-free.
    await runGit(['push', remoteUrl(input), input.branch], {
      timeoutMs: longTimeoutMs, token: input.token, cwd: input.workDir,
    })
    commitSha = (await runGit(['rev-parse', 'HEAD'], { timeoutMs: shortTimeoutMs, cwd: input.workDir })).trim()
  }
  return { commitSha }
}

/** sync → commit → push, then report the finalizing progress event. */
async function syncCommitPush(
  input: GitPushInput,
  targetDir: string,
  shortTimeoutMs: number,
  longTimeoutMs: number,
): Promise<GitPushResult> {
  const total = await syncExportFiles(input, targetDir, input.onProgress)
  const result = await commitAndPush(input, shortTimeoutMs, longTimeoutMs)
  input.onProgress?.({ phase: 'finalizing', uploaded: total, total, currentPath: '' })
  return result
}

export async function gitCliPush(input: GitPushInput): Promise<GitPushResult> {
  const targetDir = normalizeTargetDir(input.targetDir)
  const shortTimeoutMs = input.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const longTimeoutMs = input.commandTimeoutMs ?? LONG_COMMAND_TIMEOUT_MS

  // Fast path: workspace healthy → sync, commit, push.
  if (await workspaceMatches(input, neutralRemote(input), shortTimeoutMs)) {
    try {
      return await syncCommitPush(input, targetDir, shortTimeoutMs, longTimeoutMs)
    } catch (err) {
      // The self-heal path replays the push from a fresh clone; the original
      // failure is logged so transient-vs-persistent causes stay diagnosable.
      console.error('[github:gitCliPush] fast-path push failed, self-healing:', err)
    }
  }

  // Self-heal: fresh clone, then replay once. A second failure is real.
  await cloneWorkspace(input, neutralRemote(input), shortTimeoutMs, longTimeoutMs)
  try {
    return await syncCommitPush(input, targetDir, shortTimeoutMs, longTimeoutMs)
  } catch (err) {
    // Leave no half-broken workspace behind for the next run to trip over.
    await rm(input.workDir, { recursive: true, force: true })
    throw err
  }
}
