/**
 * Run a GitHub publish as a background job.
 *
 * The job runner owns the single-slot registry lifecycle: claim → run
 * publishSiteToGithub → complete/fail. The HTTP handler only starts the job
 * and returns 202; outcomes travel through the progress endpoint. Thrown
 * errors are mapped here into the wire failure shape (never echoing absolute
 * disk paths to clients).
 */
import { StaticExportError } from '@core/static-export/buildExportTree'
import type { DbClient } from '../db/client'
import { GithubPublishError, publishSiteToGithub } from './githubPublish'
import {
  completeGithubPublishJob,
  failGithubPublishJob,
  tryBeginGithubPublishJob,
  updateGithubPublishJobProgress,
} from './githubPublishJobRegistry'
import type { GithubPublishJobFailure } from './githubPublishJobRegistry'

/** Map a thrown publish error to the wire failure shape. */
function failureFor(err: unknown): GithubPublishJobFailure {
  if (err instanceof StaticExportError) {
    if (err.code === 'not-published') {
      return { code: 'not-published', message: 'Site has not been published yet.' }
    }
    if (err.code === 'per-visitor-hole') {
      return { code: 'per-visitor-hole', message: err.message, report: err.report }
    }
  }
  if (err instanceof GithubPublishError) {
    if (err.code === 'push-failed') {
      console.error('[github-publish]', err)
      // `GithubPublishError.message` for push-failed is the raw Git Data API
      // failure text ("Branch does not exist: gh-pages. …", timeout, …) —
      // self-written diagnostics with no disk paths, safe and crucial to show:
      // "push failed" alone leaves the operator nothing actionable.
      return { code: 'push-failed', message: err.message }
    }
    return { code: err.code, message: err.message }
  }
  console.error('[github-publish]', err)
  return { code: 'internal', message: 'GitHub publish failed unexpectedly.' }
}

export interface StartGithubPublishJobOptions {
  db: DbClient
  uploadsDir: string
  branch?: string
  targetDir?: string
  basePath?: string
  commitMessage?: string
}

/**
 * Start the publish job in the background. Returns false when a job is
 * already running (single-slot registry) — the caller answers 409.
 */
export function startGithubPublishJob(opts: StartGithubPublishJobOptions): boolean {
  if (!tryBeginGithubPublishJob()) return false

  void (async () => {
    try {
      const result = await publishSiteToGithub({
        db: opts.db,
        uploadsDir: opts.uploadsDir,
        branch: opts.branch,
        targetDir: opts.targetDir,
        basePath: opts.basePath,
        commitMessage: opts.commitMessage,
        onPushProgress: updateGithubPublishJobProgress,
      })
      completeGithubPublishJob(result)
    } catch (err) {
      failGithubPublishJob(failureFor(err))
    }
  })()

  return true
}
