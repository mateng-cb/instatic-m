/**
 * In-memory progress registry for the in-flight (or last) GitHub publish.
 *
 * The publish POST runs to completion — minutes for large sites on slow
 * links. This single-slot registry backs
 * `GET /admin/api/cms/github-publish/progress` so the admin UI can show
 * upload progress while that POST is pending. Self-hosted single-server
 * assumption: at most one publish runs at a time; a new publish takes over
 * the slot.
 */
import type { GitDataApiPushProgress } from '../github/types'

export type GithubPublishPhase = 'exporting' | 'uploading' | 'finalizing' | 'done'

export interface GithubPublishProgressView {
  running: boolean
  phase: GithubPublishPhase
  total: number
  uploaded: number
  currentPath: string
  /** epoch ms */
  startedAt: number
  /** epoch ms */
  updatedAt: number
}

let current: GithubPublishProgressView | null = null

export function beginGithubPublishProgress(): void {
  current = {
    running: true,
    phase: 'exporting',
    total: 0,
    uploaded: 0,
    currentPath: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function updateGithubPublishProgress(progress: GitDataApiPushProgress): void {
  if (!current?.running) return
  current = { ...current, ...progress, updatedAt: Date.now() }
}

export function endGithubPublishProgress(): void {
  if (!current) return
  current = { ...current, running: false, phase: 'done', updatedAt: Date.now() }
}

export function getGithubPublishProgress(): GithubPublishProgressView | null {
  return current
}

/** Test seam: clear the singleton slot between tests. */
export function resetGithubPublishProgress(): void {
  current = null
}
