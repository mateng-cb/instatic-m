/**
 * GitHub publish settings + push endpoints.
 *
 *   GET  /admin/api/cms/github-publish/settings — wire-safe settings view
 *   PUT  /admin/api/cms/github-publish/settings — upsert repo / branch / token
 *   GET  /admin/api/cms/github-publish/progress — in-flight publish progress
 *   POST /admin/api/cms/publish-github          — export + Git Data API push
 *
 * Settings mutations require `pages.publish` only (no step-up) — same blast
 * radius as rotating other stored credentials. The publish action itself is
 * step-up gated like local publish / static export.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { StaticExportError } from '@core/static-export/buildExportTree'
import type { DbClient } from '../../db/client'
import { requireCapability, requireStepUp } from '../../auth/authz'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import {
  GithubPublishError,
  publishSiteToGithub,
} from '../../publish/githubPublish'
import {
  beginGithubPublishProgress,
  endGithubPublishProgress,
  getGithubPublishProgress,
  updateGithubPublishProgress,
} from '../../publish/githubPublishProgress'
import {
  getGithubPublishSettingsView,
  GithubPublishSettingsError,
  upsertGithubPublishSettings,
} from '../../repositories/githubPublishSettings'
import type { CmsHandlerOptions } from './shared'
import { CMS_API_PREFIX } from './shared'

const SETTINGS_PATH = `${CMS_API_PREFIX}/github-publish/settings`
const PROGRESS_PATH = `${CMS_API_PREFIX}/github-publish/progress`
const PUBLISH_PATH = `${CMS_API_PREFIX}/publish-github`

const PutSettingsSchema = Type.Object({
  repoUrl: Type.String({ minLength: 1 }),
  branch: Type.String({ minLength: 1 }),
  targetDir: Type.String(),
  basePath: Type.String(),
  token: Type.Optional(Type.String()),
})

const PublishGithubSchema = Type.Object({
  branch: Type.Optional(Type.String()),
  targetDir: Type.Optional(Type.String()),
  basePath: Type.Optional(Type.String()),
  /** One-line commit summary; empty/omitted → default message. */
  commitMessage: Type.Optional(Type.String({ maxLength: 280 })),
})

export async function handleGithubPublishRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === SETTINGS_PATH) {
    const user = await requireCapability(req, db, 'pages.publish')
    if (user instanceof Response) return user

    if (req.method === 'GET') {
      return jsonResponse(await getGithubPublishSettingsView(db))
    }

    if (req.method === 'PUT') {
      const body = await readValidatedBody(req, PutSettingsSchema)
      if (!body) return badRequest('Invalid GitHub publish settings body')

      try {
        return jsonResponse(await upsertGithubPublishSettings(db, body))
      } catch (err) {
        if (err instanceof GithubPublishSettingsError) {
          return jsonResponse({ error: err.message }, { status: err.status })
        }
        throw err
      }
    }

    return methodNotAllowed()
  }

  if (url.pathname === PROGRESS_PATH) {
    if (req.method !== 'GET') return methodNotAllowed()

    const user = await requireCapability(req, db, 'pages.publish')
    if (user instanceof Response) return user

    return jsonResponse({ progress: getGithubPublishProgress() })
  }

  if (url.pathname === PUBLISH_PATH) {
    if (req.method !== 'POST') return methodNotAllowed()

    const user = await requireCapability(req, db, 'pages.publish')
    if (user instanceof Response) return user
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp

    if (!options.uploadsDir) {
      return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
    }

    const body = await readValidatedBody(req, PublishGithubSchema)
    if (!body) return badRequest('Invalid GitHub publish request body')

    beginGithubPublishProgress()
    try {
      const result = await publishSiteToGithub({
        db,
        uploadsDir: options.uploadsDir,
        branch: body.branch,
        targetDir: body.targetDir,
        basePath: body.basePath,
        commitMessage: body.commitMessage?.trim() || undefined,
        onPushProgress: updateGithubPublishProgress,
      })
      return jsonResponse(result)
    } catch (err) {
      if (err instanceof StaticExportError) {
        if (err.code === 'not-published') {
          return jsonResponse({ error: 'Site has not been published yet.' }, { status: 409 })
        }
        if (err.code === 'per-visitor-hole') {
          return jsonResponse({ error: err.message, report: err.report }, { status: 422 })
        }
      }
      if (err instanceof GithubPublishError) {
        if (err.code === 'token-missing' || err.code === 'config-incomplete') {
          return jsonResponse({ error: err.message }, { status: 400 })
        }
        if (err.code === 'push-failed') {
          // Keep exportDir on the server error for ops; never echo absolute
          // disk paths to the client response body.
          console.error('[github-publish]', err)
          return jsonResponse(
            {
              error:
                'GitHub push failed. The export directory was kept on the server for retry or inspection.',
            },
            { status: 502 },
          )
        }
      }
      throw err
    } finally {
      endGithubPublishProgress()
    }
  }

  return null
}
