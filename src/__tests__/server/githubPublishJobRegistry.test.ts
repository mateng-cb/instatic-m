/**
 * In-memory GitHub publish job registry — pure singleton unit tests.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  completeGithubPublishJob,
  failGithubPublishJob,
  getGithubPublishJob,
  resetGithubPublishJob,
  tryBeginGithubPublishJob,
  updateGithubPublishJobProgress,
} from '../../../server/publish/githubPublishJobRegistry'

const SAMPLE_RESULT = {
  commitSha: 'abc123def456',
  repoUrl: 'https://github.com/acme/my-site',
  branch: 'gh-pages',
  report: [],
}

describe('githubPublishJobRegistry', () => {
  afterEach(() => {
    resetGithubPublishJob()
  })

  test('lifecycle: begin → update → complete', () => {
    expect(getGithubPublishJob()).toBeNull()

    expect(tryBeginGithubPublishJob()).toBe(true)
    expect(getGithubPublishJob()).toMatchObject({
      state: 'running',
      phase: 'exporting',
      total: 0,
      uploaded: 0,
      currentPath: '',
    })

    updateGithubPublishJobProgress({
      phase: 'uploading',
      uploaded: 1,
      total: 3,
      currentPath: 'index.html',
    })
    expect(getGithubPublishJob()).toMatchObject({
      state: 'running',
      phase: 'uploading',
      uploaded: 1,
      total: 3,
      currentPath: 'index.html',
    })

    completeGithubPublishJob(SAMPLE_RESULT)
    expect(getGithubPublishJob()).toMatchObject({
      state: 'succeeded',
      result: SAMPLE_RESULT,
    })
    const view = getGithubPublishJob()
    expect(view?.endedAt).toBeNumber()
    expect(view?.endedAt).toBeGreaterThanOrEqual(view!.startedAt)
  })

  test('begin → update → fail carries the failure view', () => {
    tryBeginGithubPublishJob()
    failGithubPublishJob({
      code: 'push-failed',
      message: 'GitHub push failed. The export directory was kept on the server.',
    })
    expect(getGithubPublishJob()).toMatchObject({
      state: 'failed',
      failure: {
        code: 'push-failed',
        message: 'GitHub push failed. The export directory was kept on the server.',
      },
    })
  })

  test('a running job blocks the slot; a settled job releases it', () => {
    expect(tryBeginGithubPublishJob()).toBe(true)
    expect(tryBeginGithubPublishJob()).toBe(false)

    completeGithubPublishJob(SAMPLE_RESULT)
    expect(tryBeginGithubPublishJob()).toBe(true)
  })

  test('update without a running job is a no-op', () => {
    updateGithubPublishJobProgress({
      phase: 'uploading',
      uploaded: 1,
      total: 1,
      currentPath: 'x',
    })
    expect(getGithubPublishJob()).toBeNull()
  })

  test('update after settle does not revive the job', () => {
    tryBeginGithubPublishJob()
    completeGithubPublishJob(SAMPLE_RESULT)
    updateGithubPublishJobProgress({
      phase: 'uploading',
      uploaded: 1,
      total: 1,
      currentPath: 'x',
    })
    expect(getGithubPublishJob()).toMatchObject({ state: 'succeeded' })
  })
})
