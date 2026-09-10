/**
 * GitHub publish settings + local push kit endpoints.
 *
 *   GET  /admin/api/cms/github-publish/settings     — wire-safe settings view
 *   PUT  /admin/api/cms/github-publish/settings     — upsert repo / branch / token
 *   POST /admin/api/cms/github-publish/push-package — ZIP: static export + push
 *                                                    scripts, run locally
 *
 * The server never talks to GitHub — the kit's push scripts do, from the
 * operator's machine (see server/publish/localPushKit.ts). That sidesteps
 * restricted / high-latency server egress to api.github.com entirely.
 *
 * Settings mutations require `pages.publish` only (no step-up) — same blast
 * radius as rotating other stored credentials. Building the kit is step-up
 * gated like local publish / static export: it serialises the full site (and
 * optionally embeds the stored PAT).
 */
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { StaticExportError } from '@core/static-export/buildExportTree'
import type { DbClient } from '../../db/client'
import { requireCapability, requireStepUp } from '../../auth/authz'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { buildLocalPushKit, LocalPushKitError } from '../../publish/localPushKit'
import { createExportZipStream } from '../../publish/staticExport'
import {
  getGithubPublishSettingsView,
  GithubPublishSettingsError,
  upsertGithubPublishSettings,
} from '../../repositories/githubPublishSettings'
import type { CmsHandlerOptions } from './shared'
import { CMS_API_PREFIX } from './shared'
import { withDeferredCleanup } from './staticExport'

const SETTINGS_PATH = `${CMS_API_PREFIX}/github-publish/settings`
const PUSH_PACKAGE_PATH = `${CMS_API_PREFIX}/github-publish/push-package`

const PutSettingsSchema = Type.Object({
  repoUrl: Type.String({ minLength: 1 }),
  branch: Type.String({ minLength: 1 }),
  basePath: Type.String(),
  /** Absolute server path of the persistent git working clone; omit = keep, '' = default. */
  workdir: Type.Optional(Type.String()),
  token: Type.Optional(Type.String()),
})

const PushPackageSchema = Type.Object({
  /** Embed the stored PAT into the push scripts (zero-interaction push). */
  embedToken: Type.Optional(Type.Boolean()),
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

  if (url.pathname === PUSH_PACKAGE_PATH) {
    if (req.method !== 'POST') return methodNotAllowed()

    const user = await requireCapability(req, db, 'pages.publish')
    if (user instanceof Response) return user
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp

    if (!options.uploadsDir) {
      return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
    }

    const body = await readValidatedBody(req, PushPackageSchema)
    if (!body) return badRequest('Invalid push package request body')

    const kitDir = join(tmpdir(), `instatic-push-kit-${randomUUID()}`)
    const cleanupKitDir = () => rm(kitDir, { recursive: true, force: true })

    try {
      await buildLocalPushKit({
        db,
        uploadsDir: options.uploadsDir,
        kitDir,
        embedToken: body.embedToken ?? false,
      })

      // ZIP entries stream from files under kitDir — only delete after the
      // response body finishes (or the client cancels), not in a sync finally.
      const stream = withDeferredCleanup(await createExportZipStream(kitDir), cleanupKitDir)
      return new Response(stream, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="instatic-push-kit.zip"',
        },
      })
    } catch (err) {
      await cleanupKitDir()
      if (err instanceof StaticExportError) {
        if (err.code === 'not-published') {
          return jsonResponse({ error: 'Site has not been published yet.' }, { status: 409 })
        }
        if (err.code === 'per-visitor-hole') {
          return jsonResponse({ error: err.message, report: err.report }, { status: 422 })
        }
      }
      if (err instanceof LocalPushKitError) {
        return jsonResponse({ error: err.message }, { status: err.status })
      }
      throw err
    }
  }

  return null
}
