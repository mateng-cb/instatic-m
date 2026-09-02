export type ParsedGithubRepo = {
  owner: string
  repo: string
  repoUrl: string
}

const UNSUPPORTED_HOST = 'Only github.com repositories are supported'

function canonicalize(owner: string, repo: string): ParsedGithubRepo {
  return {
    owner,
    repo,
    repoUrl: `https://github.com/${owner}/${repo}`,
  }
}

function stripGitSuffix(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -4) : name
}

function parseSshUrl(input: string): ParsedGithubRepo | null {
  const match = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(input)
  if (!match) return null
  const [, owner, repo] = match
  return canonicalize(owner, stripGitSuffix(repo))
}

function parseHttpsUrl(input: string): ParsedGithubRepo {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(UNSUPPORTED_HOST)
  }

  const host = url.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw new Error(UNSUPPORTED_HOST)
  }

  const [owner, repoSegment, ...rest] = url.pathname.split('/').filter(Boolean)
  if (!owner || !repoSegment || rest.length > 0) {
    throw new Error(UNSUPPORTED_HOST)
  }

  return canonicalize(owner, stripGitSuffix(repoSegment))
}

export function parseGithubRepoUrl(input: string): ParsedGithubRepo {
  const trimmed = input.trim()
  const ssh = parseSshUrl(trimmed)
  if (ssh) return ssh
  return parseHttpsUrl(trimmed)
}
