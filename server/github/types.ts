/**
 * Shared types for GitHub publish (git CLI push + callers).
 */

export type GitPushProgress = {
  phase: 'uploading' | 'finalizing'
  uploaded: number
  total: number
  /** Repo path of the most recently copied file; '' before the first. */
  currentPath: string
}

export type GitPushInput = {
  token: string
  owner: string
  repo: string
  branch: string
  /** '' = replace the entire branch tree; non-empty = replace only that prefix */
  targetDir: string
  /** Absolute path to the Phase A export outDir */
  exportDir: string
  /**
   * Path of the persistent git working clone (absolute or relative to the
   * server CWD). Created on first use, self-healed (wiped + re-cloned) on
   * any git failure or repo/branch switch.
   */
  workDir: string
  commitMessage?: string
  /**
   * Per-git-command timeout in ms (test seam). Defaults to 120s for short
   * commands (status, add, ls-remote, …) and 10min for clone/push.
   */
  commandTimeoutMs?: number
  /** Test seam: remote base override (e.g. a local bare repo path). */
  remoteBaseUrl?: string
  onProgress?: (progress: GitPushProgress) => void
}

export type GitPushResult = {
  commitSha: string
}
