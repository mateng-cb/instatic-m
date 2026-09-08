import { apiBlobRequest, type FetchLike } from '@core/http'
import type { ExportLayout, PathMode } from '@core/static-export'

export async function downloadStaticExport(
  options: {
    pathMode: PathMode
    layout: ExportLayout
    basePath?: string
  },
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<Blob> {
  return apiBlobRequest(`${basePath}/export-static`, {
    method: 'POST',
    body: options,
    fetchImpl,
    fallbackMessage: 'Static export download failed',
  })
}
