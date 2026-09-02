/**
 * Shared types for GitHub publish (Git Data API push + callers).
 */

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
}

export type GitDataApiPushResult = {
  commitSha: string
  treeSha: string
}
