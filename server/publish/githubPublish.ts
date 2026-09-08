/**
 * Orchestrate Phase A static export → GitHub Git Data API push.
 *
 * Owns temp-dir lifecycle: remove on export failure or push success;
 * keep on push failure so operators can inspect / retry.
 */

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeBasePath } from '@core/static-export/rewriteUrls'
import type { ExportReportItem } from '@core/static-export/types'
import type { DbClient } from '../db/client'
import { gitDataApiPush } from '../github/gitDataApiPush'
import type { GitDataApiPushProgress } from '../github/types'
import {
  decryptGithubPublishToken,
  getGithubPublishSettingsView,
} from '../repositories/githubPublishSettings'
import { exportPublishedSiteStatic } from './staticExport'
import { createStaticExportHoleHooks } from './staticExportHoles'

export class GithubPublishError extends Error {
  readonly code: 'token-missing' | 'config-incomplete' | 'push-failed'
  readonly exportDir?: string

  constructor(
    code: 'token-missing' | 'config-incomplete' | 'push-failed',
    message: string,
    options?: ErrorOptions & { exportDir?: string },
  ) {
    super(message, options)
    this.name = 'GithubPublishError'
    this.code = code
    this.exportDir = options?.exportDir
  }
}

export type PublishSiteToGithubResult = {
  commitSha: string
  repoUrl: string
  branch: string
  report: ExportReportItem[]
}

export async function publishSiteToGithub(opts: {
  db: DbClient
  uploadsDir: string
  /** overrides from POST body; missing → settings row */
  branch?: string
  targetDir?: string
  basePath?: string
  /** commit summary; undefined → push default ("Publish site from Instatic") */
  commitMessage?: string
  /** test seams */
  exportFn?: typeof exportPublishedSiteStatic
  pushFn?: typeof gitDataApiPush
  /** push progress → caller (progress registry / logs). */
  onPushProgress?: (progress: GitDataApiPushProgress) => void
}): Promise<PublishSiteToGithubResult> {
  const settings = await getGithubPublishSettingsView(opts.db)

  if (!settings.hasToken) {
    throw new GithubPublishError(
      'token-missing',
      'GitHub publish token is not configured. Add a personal access token in settings.',
    )
  }

  if (!settings.repoUrl.trim() || !settings.owner || !settings.repo) {
    throw new GithubPublishError(
      'config-incomplete',
      'GitHub repository URL is not configured.',
    )
  }

  const token = await decryptGithubPublishToken(opts.db)
  if (token === null) {
    throw new GithubPublishError(
      'token-missing',
      'GitHub publish token is missing or could not be decrypted. Re-enter the token in settings.',
    )
  }

  const branch = (opts.branch ?? settings.branch).trim() || 'gh-pages'
  const targetDir = opts.targetDir ?? settings.targetDir
  const basePath = normalizeBasePath(opts.basePath ?? settings.basePath)

  const outDir = join(tmpdir(), `instatic-gh-publish-${randomUUID()}`)
  const exportFn = opts.exportFn ?? exportPublishedSiteStatic
  const pushFn = opts.pushFn ?? gitDataApiPush

  let report: ExportReportItem[]
  try {
    const result = await exportFn({
      uploadsDir: opts.uploadsDir,
      outDir,
      pathMode: 'basePath',
      basePath,
      expandHoles: createStaticExportHoleHooks(opts.db),
    })
    report = result.report
  } catch (err) {
    await rm(outDir, { recursive: true, force: true })
    throw err
  }

  try {
    const pushResult = await pushFn({
      token,
      owner: settings.owner,
      repo: settings.repo,
      branch,
      targetDir,
      exportDir: outDir,
      commitMessage: opts.commitMessage,
      onProgress: opts.onPushProgress,
    })
    await rm(outDir, { recursive: true, force: true })
    return {
      commitSha: pushResult.commitSha,
      repoUrl: settings.repoUrl,
      branch,
      report,
    }
  } catch (err) {
    throw new GithubPublishError(
      'push-failed',
      err instanceof Error ? err.message : 'GitHub push failed.',
      { cause: err, exportDir: outDir },
    )
  }
}
