/**
 * Static site export endpoint.
 *
 *   POST /admin/api/cms/export-static — ZIP of the published slot, with shared
 *                                          dynamic holes inlined and per-visitor
 *                                          holes rejected (422).
 *
 * Gated by `pages.publish` + step-up — same blast radius as publish.
 */
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { StaticExportError } from '@core/static-export/buildExportTree'
import { normalizeBasePath } from '@core/static-export/rewriteUrls'
import type { DbClient } from '../../db/client'
import { requireCapability, requireStepUp } from '../../auth/authz'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import {
  createExportZipStream,
  exportPublishedSiteStatic,
} from '../../publish/staticExport'
import { createStaticExportHoleHooks } from '../../publish/staticExportHoles'
import type { CmsHandlerOptions } from './shared'
import { CMS_API_PREFIX } from './shared'

const EXPORT_STATIC_PATH = `${CMS_API_PREFIX}/export-static`

const StaticExportRequestSchema = Type.Object({
  pathMode: Type.Optional(Type.Union([Type.Literal('relative'), Type.Literal('basePath')])),
  layout: Type.Optional(Type.Union([Type.Literal('directory'), Type.Literal('flat')])),
  basePath: Type.Optional(Type.String()),
})

export async function handleStaticExportRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== EXPORT_STATIC_PATH) return null
  if (req.method !== 'POST') return methodNotAllowed()

  const user = await requireCapability(req, db, 'pages.publish')
  if (user instanceof Response) return user
  const stepUp = await requireStepUp(req, db, user)
  if (stepUp) return stepUp

  if (!options.uploadsDir) {
    return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
  }

  const body = await readValidatedBody(req, StaticExportRequestSchema)
  if (!body) return badRequest('Invalid static export request body')

  const pathMode = body.pathMode ?? 'relative'
  const layout = body.layout ?? 'directory'
  let basePath = ''
  if (pathMode === 'basePath') {
    if (!body.basePath?.trim()) {
      return badRequest('basePath is required when pathMode is basePath')
    }
    basePath = normalizeBasePath(body.basePath)
  }

  const outDir = join(tmpdir(), `instatic-static-export-${randomUUID()}`)
  const cleanupOutDir = () => rm(outDir, { recursive: true, force: true })

  try {
    await exportPublishedSiteStatic({
      uploadsDir: options.uploadsDir,
      outDir,
      pathMode,
      layout,
      basePath,
      expandHoles: createStaticExportHoleHooks(db),
    })

    // ZIP entries stream from files under outDir — only delete after the
    // response body finishes (or the client cancels), not in a sync finally.
    const stream = withDeferredCleanup(await createExportZipStream(outDir), cleanupOutDir)
    return new Response(stream, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="instatic-static-export.zip"',
      },
    })
  } catch (err) {
    await cleanupOutDir()
    if (err instanceof StaticExportError) {
      if (err.code === 'not-published') {
        return jsonResponse({ error: 'Site has not been published yet.' }, { status: 409 })
      }
      if (err.code === 'per-visitor-hole') {
        return jsonResponse({ error: err.message, report: err.report }, { status: 422 })
      }
    }
    throw err
  }
}

/** Pipe a stream and run cleanup once it closes, errors, or is cancelled. */
function withDeferredCleanup(
  stream: ReadableStream<Uint8Array>,
  cleanup: () => Promise<void>,
): ReadableStream<Uint8Array> {
  let cleaned = false
  const runCleanup = () => {
    if (cleaned) return
    cleaned = true
    void cleanup()
  }

  return new ReadableStream({
    async start(controller) {
      const reader = stream.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          controller.enqueue(value)
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        reader.releaseLock()
        runCleanup()
      }
    },
    cancel(reason) {
      void stream.cancel(reason)
      runCleanup()
    },
  })
}
