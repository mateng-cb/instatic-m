/**
 * In-memory single-slot job registry for GitHub publish.
 *
 * POST /admin/api/cms/publish-github starts the publish in the background and
 * returns 202 immediately — reverse proxies (Cloudflare and friends) cut
 * synchronous responses at ~100 s, and a multi-minute Git Data API push can
 * never fit inside one request. This registry is the job's state machine:
 * `GET /admin/api/cms/github-publish/progress` returns the current view, and
 * the admin UI polls it for live progress and the final outcome.
 *
 * Self-hosted single-server assumption: one job at a time. The settled view
 * survives until the next job replaces it; the registry cannot outlive a
 * process restart (the poller treats a vanished job as an interruption).
 */
import type { ExportReportItem } from '@core/static-export/types'
import type { GitPushProgress } from '../github/types'

export type GithubPublishJobPhase = 'exporting' | 'uploading' | 'finalizing'

export type GithubPublishJobState = 'running' | 'succeeded' | 'failed'

export type GithubPublishJobFailureCode =
  | 'not-published'
  | 'per-visitor-hole'
  | 'token-missing'
  | 'config-incomplete'
  | 'push-failed'
  | 'internal'

export interface GithubPublishJobFailure {
  code: GithubPublishJobFailureCode
  message: string
  /** Present for `per-visitor-hole` — the hole detection report. */
  report?: ExportReportItem[]
}

export interface GithubPublishJobResult {
  commitSha: string
  repoUrl: string
  branch: string
  report: ExportReportItem[]
}

export interface GithubPublishJobView {
  state: GithubPublishJobState
  phase: GithubPublishJobPhase
  total: number
  uploaded: number
  currentPath: string
  /** epoch ms */
  startedAt: number
  /** epoch ms */
  updatedAt: number
  /** epoch ms; absent while running */
  endedAt?: number
  /** Present when state === 'succeeded' */
  result?: GithubPublishJobResult
  /** Present when state === 'failed' */
  failure?: GithubPublishJobFailure
}

let current: GithubPublishJobView | null = null

/**
 * Claim the job slot. Returns false when a job is already running — callers
 * translate that into HTTP 409.
 */
export function tryBeginGithubPublishJob(): boolean {
  if (current?.state === 'running') return false
  current = {
    state: 'running',
    phase: 'exporting',
    total: 0,
    uploaded: 0,
    currentPath: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  return true
}

export function updateGithubPublishJobProgress(progress: GitPushProgress): void {
  if (current?.state !== 'running') return
  current = { ...current, ...progress, updatedAt: Date.now() }
}

export function completeGithubPublishJob(result: GithubPublishJobResult): void {
  if (current?.state !== 'running') return
  current = { ...current, state: 'succeeded', result, endedAt: Date.now(), updatedAt: Date.now() }
}

export function failGithubPublishJob(failure: GithubPublishJobFailure): void {
  if (current?.state !== 'running') return
  current = { ...current, state: 'failed', failure, endedAt: Date.now(), updatedAt: Date.now() }
}

export function getGithubPublishJob(): GithubPublishJobView | null {
  return current
}

/** Test seam: clear the singleton slot between tests. */
export function resetGithubPublishJob(): void {
  current = null
}
