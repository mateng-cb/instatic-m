import { describe, expect, test } from 'bun:test'
import { parseGithubRepoUrl } from '../../../server/github/parseRepoUrl'

const canonical = {
  owner: 'acme',
  repo: 'site',
  repoUrl: 'https://github.com/acme/site',
}

describe('parseGithubRepoUrl', () => {
  test('parses https github.com URLs', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/site.git')).toEqual(canonical)
  })

  test('parses URLs without .git suffix', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/site')).toEqual(canonical)
  })

  test('parses URLs with trailing slash', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/site/')).toEqual(canonical)
  })

  test('parses www.github.com URLs', () => {
    expect(parseGithubRepoUrl('https://www.github.com/acme/site')).toEqual(canonical)
  })

  test('parses git@github.com SSH URLs', () => {
    expect(parseGithubRepoUrl('git@github.com:acme/site.git')).toEqual(canonical)
  })

  test('parses git@github.com SSH URLs without .git', () => {
    expect(parseGithubRepoUrl('git@github.com:acme/site')).toEqual(canonical)
  })

  test('rejects non-github hosts', () => {
    expect(() => parseGithubRepoUrl('https://gitlab.com/acme/site')).toThrow(
      'Only github.com repositories are supported',
    )
  })
})
