/**
 * Shared types for GitHub publish (Git Data API push + callers).
 */

export type GitDataApiPushProgress = {
  phase: 'uploading' | 'finalizing'
  uploaded: number
  total: number
  /** Repo path of the most recently completed blob; '' before the first. */
  currentPath: string
}

export type GitDataApiPushInput = {
  token: string
  owner: string
  repo: string
  branch: string
  /** '' = replace entire branch tree */
  targetDir: string
  /** Absolute path to Phase A export outDir */
  exportDir: string
  commitMessage?: string
  fetchImpl?: typeof fetch
  /** Per-request timeout in ms (test seam); defaults to 60s. */
  requestTimeoutMs?: number
  onProgress?: (progress: GitDataApiPushProgress) => void
}

export type GitDataApiPushResult = {
  commitSha: string
  treeSha: string
}
