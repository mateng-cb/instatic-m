/**
 * GitHub publish settings + job endpoints.
 *
 *   GET  /admin/api/cms/github-publish/settings — wire-safe settings view
 *   PUT  /admin/api/cms/github-publish/settings — upsert repo / branch / token
 *   GET  /admin/api/cms/github-publish/progress — job view (live or settled)
 *   POST /admin/api/cms/publish-github          — start the export + push job
 *
 * Settings mutations require `pages.publish` only (no step-up) — same blast
 * radius as rotating other stored credentials. The publish action itself is
 * step-up gated like local publish / static export.
 *
 * The publish POST starts a background job and returns 202 immediately:
 * a full-site Git Data API push runs minutes, longer than reverse-proxy
 * response timeouts (Cloudflare cuts at ~100 s). Outcomes — success result
 * or failure — surface on the progress endpoint, which the admin UI polls.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { DbClient } from '../../db/client'
import { requireCapability, requireStepUp } from '../../auth/authz'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { startGithubPublishJob } from '../../publish/githubPublishJob'
import { getGithubPublishJob } from '../../publish/githubPublishJobRegistry'
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
  /** Absolute server path of the persistent git working clone; omit = keep, '' = default. */
  workdir: Type.Optional(Type.String()),
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

    return jsonResponse({ job: getGithubPublishJob() })
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

    const started = startGithubPublishJob({
      db,
      uploadsDir: options.uploadsDir,
      branch: body.branch,
      targetDir: body.targetDir,
      basePath: body.basePath,
      commitMessage: body.commitMessage?.trim() || undefined,
    })
    if (!started) {
      return jsonResponse({ error: 'A GitHub publish is already in progress.' }, { status: 409 })
    }
    // The registry slot now holds the freshly claimed running job; its
    // startedAt lets the client's poller distinguish this run from the
    // previous job's settled leftovers.
    const job = getGithubPublishJob()
    return jsonResponse({ started: true, startedAt: job?.startedAt ?? Date.now() }, { status: 202 })
  }

  return null
}
