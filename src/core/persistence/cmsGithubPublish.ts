import { apiRequest, type FetchLike } from '@core/http'
import {
  GithubPublishJobResponseSchema,
  GithubPublishSettingsViewSchema,
  StartGithubPublishResponseSchema,
  type GithubPublishJobResponse,
  type GithubPublishSettingsView,
  type StartGithubPublishResponse,
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

export async function getGithubPublishJob(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<GithubPublishJobResponse> {
  return apiRequest(`${basePath}/github-publish/progress`, {
    schema: GithubPublishJobResponseSchema,
    fetchImpl,
    fallbackMessage: 'GitHub publish progress request failed',
  })
}

export async function startGithubPublish(
  body: {
    branch?: string
    targetDir?: string
    basePath?: string
    commitMessage?: string
  } = {},
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<StartGithubPublishResponse> {
  return apiRequest(`${basePath}/publish-github`, {
    method: 'POST',
    body,
    schema: StartGithubPublishResponseSchema,
    fetchImpl,
    fallbackMessage: 'Starting GitHub publish failed',
  })
}
