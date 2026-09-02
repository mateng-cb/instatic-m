import { apiRequest, type FetchLike } from '@core/http'
import {
  GithubPublishSettingsViewSchema,
  PublishGithubResultSchema,
  type GithubPublishSettingsView,
  type PublishGithubResult,
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
    targetDir: string
    basePath: string
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

export async function publishToGithub(
  body: {
    branch?: string
    targetDir?: string
    basePath?: string
  } = {},
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<PublishGithubResult> {
  return apiRequest(`${basePath}/publish-github`, {
    method: 'POST',
    body,
    schema: PublishGithubResultSchema,
    fetchImpl,
    fallbackMessage: 'GitHub publish failed',
  })
}
