import { apiBlobRequest, apiRequest, type FetchLike } from '@core/http'
import {
  GithubPublishSettingsViewSchema,
  type GithubPublishSettingsView,
} from './responseSchemas'

export async function getGithubPublishSettings(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<GithubPublishSettingsView> {
  return apiRequest(`${basePath}/github-publish/settings`, {
    schema: GithubPublishSettingsViewSchema,
    fetchImpl,
    fallbackMessage: 'GitHub publish settings request failed',
  })
}

export async function putGithubPublishSettings(
  body: {
    repoUrl: string
    branch: string
    basePath: string
    /** omit = keep existing; '' = clear back to the server default */
    workdir?: string
    token?: string
  },
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<GithubPublishSettingsView> {
  return apiRequest(`${basePath}/github-publish/settings`, {
    method: 'PUT',
    body,
    schema: GithubPublishSettingsViewSchema,
    fetchImpl,
    fallbackMessage: 'GitHub publish settings update failed',
  })
}

/**
 * Download the local push kit ZIP: the basePath-rewritten static export plus
 * push scripts that publish it to GitHub from the operator's machine. The
 * caller saves the Blob to disk.
 */
export async function downloadGithubPushKit(
  options: { embedToken: boolean },
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<Blob> {
  return apiBlobRequest(`${basePath}/github-publish/push-package`, {
    method: 'POST',
    body: options,
    fetchImpl,
    fallbackMessage: 'Push kit download failed',
  })
}
