/**
 * Canonical locations of this repository on the self-hosted GitLab
 * instance. Single source for help links the admin UI ships to the
 * browser — change the instance address here, not at each call site.
 */

export const REPO_URL = 'http://192.168.3.106:8881/instatic/instatic-dite'

export const REPO_DOCS_URL = `${REPO_URL}/-/blob/main/docs`

/** URL of a docs page inside the repository, relative to `docs/`. */
export function repoDocsUrl(docPath: string): string {
  return `${REPO_DOCS_URL}/${docPath}`
}

export const REPO_NEW_ISSUE_URL = `${REPO_URL}/-/issues/new`
