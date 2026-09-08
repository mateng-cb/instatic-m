/**
 * In-memory GitHub publish progress registry — pure singleton unit tests.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  beginGithubPublishProgress,
  endGithubPublishProgress,
  getGithubPublishProgress,
  resetGithubPublishProgress,
  updateGithubPublishProgress,
} from '../../../server/publish/githubPublishProgress'

describe('githubPublishProgress registry', () => {
  afterEach(() => {
    resetGithubPublishProgress()
  })

  test('lifecycle: begin → update → end', () => {
    expect(getGithubPublishProgress()).toBeNull()

    beginGithubPublishProgress()
    expect(getGithubPublishProgress()).toMatchObject({
      running: true,
      phase: 'exporting',
      total: 0,
      uploaded: 0,
      currentPath: '',
    })

    updateGithubPublishProgress({
      phase: 'uploading',
      uploaded: 1,
      total: 3,
      currentPath: 'index.html',
    })
    expect(getGithubPublishProgress()).toMatchObject({
      running: true,
      phase: 'uploading',
      uploaded: 1,
      total: 3,
      currentPath: 'index.html',
    })

    endGithubPublishProgress()
    expect(getGithubPublishProgress()).toMatchObject({ running: false, phase: 'done' })
  })

  test('update without a running publish is a no-op', () => {
    updateGithubPublishProgress({
      phase: 'uploading',
      uploaded: 1,
      total: 1,
      currentPath: 'x',
    })
    expect(getGithubPublishProgress()).toBeNull()
  })

  test('update after end does not revive the slot', () => {
    beginGithubPublishProgress()
    endGithubPublishProgress()
    updateGithubPublishProgress({
      phase: 'uploading',
      uploaded: 1,
      total: 1,
      currentPath: 'x',
    })
    expect(getGithubPublishProgress()).toMatchObject({ running: false, phase: 'done' })
  })
})
