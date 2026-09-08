import { apiBlobRequest, type FetchLike } from '@core/http'

export async function downloadStaticExport(
  options: {
    pathMode: 'relative' | 'basePath'
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
