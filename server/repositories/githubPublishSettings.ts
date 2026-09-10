/**
 * GitHub publish settings repository — CRUD over `github_publish_settings`.
 *
 * Owns:
 *   - All SQL touching the singleton settings row (`id = 'default'`).
 *   - PAT encryption on write + decryption for the local push kit
 *     (`decryptGithubPublishToken`).
 *   - The wire-safe `GithubPublishSettingsView` projection — the ONLY shape
 *     from this table that may cross the HTTP boundary.
 *
 * Does NOT own:
 *   - HTTP semantics (handlers map `GithubPublishSettingsError.status`).
 *   - The push kit itself (`server/publish/localPushKit.ts`).
 *
 * The legacy `target_dir` column stays in the table (additive-only schema
 * policy) but is no longer read or written — the push kit always replaces the
 * whole branch tree.
 */

import type { DbClient } from '../db/client'
import { parseGithubRepoUrl } from '../github/parseRepoUrl'
import { decryptSecret, encryptSecret } from '../secrets/encryption'
import {
  getMasterKeyFingerprint,
  loadMasterKey,
  MasterKeyConfigurationError,
} from '../secrets/masterKey'
import { isoDateOrNull } from '@core/utils/isoDate'

const ROW_ID = 'default'

/** Branch names become shell arguments in the generated push scripts — keep
 * them on a strict allowlist at the persistence boundary. */
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export type GithubPublishSettingsView = {
  repoUrl: string
  owner: string
  repo: string
  branch: string
  basePath: string
  hasToken: boolean
  keyFingerprintCurrent: boolean
  updatedAt: string | null
}

export type UpsertGithubPublishSettingsInput = {
  repoUrl: string
  branch: string
  basePath: string
  /** omit = keep; '' = clear; other = rotate */
  token?: string
}

interface GithubPublishSettingsRow {
  repo_url: string
  owner: string
  repo: string
  branch: string
  base_path: string
  token_ciphertext: Uint8Array | null
  token_iv: Uint8Array | null
  key_fingerprint: string | null
  updated_at: Date | string | null
}

/**
 * Typed error for settings persistence failures that handlers turn into a
 * `{ error }` envelope. Mirrors `PluginSecretError` in plugin secrets.
 */
export class GithubPublishSettingsError extends Error {
  readonly status: number

  constructor(message: string, status = 400, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GithubPublishSettingsError'
    this.status = status
  }
}

function secretEncryptionConfigurationError(
  err: MasterKeyConfigurationError,
): GithubPublishSettingsError {
  return new GithubPublishSettingsError(
    `GitHub publish token encryption is not configured: ${err.message.replace('[secrets/masterKey] ', '')}`,
    500,
    { cause: err },
  )
}

function emptyView(): GithubPublishSettingsView {
  return {
    repoUrl: '',
    owner: '',
    repo: '',
    branch: 'gh-pages',
    basePath: '',
    hasToken: false,
    keyFingerprintCurrent: true,
    updatedAt: null,
  }
}

async function rowToView(row: GithubPublishSettingsRow): Promise<GithubPublishSettingsView> {
  const hasToken = row.token_ciphertext !== null && row.token_iv !== null
  const currentFingerprint = row.key_fingerprint
    ? await getMasterKeyFingerprint()
    : null

  return {
    repoUrl: row.repo_url,
    owner: row.owner,
    repo: row.repo,
    branch: row.branch,
    basePath: row.base_path,
    hasToken,
    keyFingerprintCurrent:
      row.key_fingerprint === null ? true : row.key_fingerprint === currentFingerprint,
    updatedAt: isoDateOrNull(row.updated_at),
  }
}

async function readRow(db: DbClient): Promise<GithubPublishSettingsRow | null> {
  const { rows } = await db<GithubPublishSettingsRow>`
    select repo_url, owner, repo, branch, base_path,
           token_ciphertext, token_iv, key_fingerprint, updated_at
    from github_publish_settings
    where id = ${ROW_ID}
    limit 1
  `
  return rows[0] ?? null
}

export async function getGithubPublishSettingsView(
  db: DbClient,
): Promise<GithubPublishSettingsView> {
  const row = await readRow(db)
  if (!row) return emptyView()
  return rowToView(row)
}

async function resolveTokenFields(
  db: DbClient,
  token: string | undefined,
): Promise<{
  tokenCiphertext: Uint8Array | null
  tokenIv: Uint8Array | null
  keyFingerprint: string | null
}> {
  if (token === undefined) {
    const existing = await readRow(db)
    return {
      tokenCiphertext: existing?.token_ciphertext ?? null,
      tokenIv: existing?.token_iv ?? null,
      keyFingerprint: existing?.key_fingerprint ?? null,
    }
  }

  if (token === '') {
    return {
      tokenCiphertext: null,
      tokenIv: null,
      keyFingerprint: null,
    }
  }

  try {
    const masterKey = await loadMasterKey()
    const { ciphertext, iv } = await encryptSecret(masterKey, token)
    return {
      tokenCiphertext: ciphertext,
      tokenIv: iv,
      keyFingerprint: await getMasterKeyFingerprint(),
    }
  } catch (err) {
    if (err instanceof MasterKeyConfigurationError) {
      throw secretEncryptionConfigurationError(err)
    }
    throw new GithubPublishSettingsError('Failed to encrypt GitHub publish token.', 500, {
      cause: err,
    })
  }
}

export async function upsertGithubPublishSettings(
  db: DbClient,
  input: UpsertGithubPublishSettingsInput,
): Promise<GithubPublishSettingsView> {
  let parsed: ReturnType<typeof parseGithubRepoUrl>
  try {
    parsed = parseGithubRepoUrl(input.repoUrl)
  } catch (err) {
    throw new GithubPublishSettingsError(
      err instanceof Error ? err.message : 'Invalid GitHub repository URL.',
      400,
      { cause: err },
    )
  }

  const branch = input.branch.trim()
  if (!BRANCH_PATTERN.test(branch)) {
    throw new GithubPublishSettingsError(
      'Branch name may only contain letters, digits, ".", "_", "-", "/" and must not start with "." or "/"',
    )
  }

  const { tokenCiphertext, tokenIv, keyFingerprint } = await resolveTokenFields(db, input.token)

  const { rows } = await db<GithubPublishSettingsRow>`
    insert into github_publish_settings (
      id, repo_url, owner, repo, branch, base_path,
      token_ciphertext, token_iv, key_fingerprint
    )
    values (
      ${ROW_ID}, ${parsed.repoUrl}, ${parsed.owner}, ${parsed.repo},
      ${branch}, ${input.basePath},
      ${tokenCiphertext}, ${tokenIv}, ${keyFingerprint}
    )
    on conflict (id) do update
      set repo_url = excluded.repo_url,
          owner = excluded.owner,
          repo = excluded.repo,
          branch = excluded.branch,
          base_path = excluded.base_path,
          token_ciphertext = excluded.token_ciphertext,
          token_iv = excluded.token_iv,
          key_fingerprint = excluded.key_fingerprint,
          updated_at = current_timestamp
    returning repo_url, owner, repo, branch, base_path,
              token_ciphertext, token_iv, key_fingerprint, updated_at
  `

  return rowToView(rows[0]!)
}

/**
 * Decrypt the stored GitHub PAT for push. SERVER-SIDE RUNTIME USE ONLY —
 * must never be serialised onto a browser-bound response.
 *
 * Returns null when no token is stored, the master key fingerprint no longer
 * matches, or decryption fails.
 */
export async function decryptGithubPublishToken(db: DbClient): Promise<string | null> {
  const row = await readRow(db)
  if (!row?.token_ciphertext || !row.token_iv) return null

  let masterKey: CryptoKey
  let currentFingerprint: string
  try {
    masterKey = await loadMasterKey()
    currentFingerprint = await getMasterKeyFingerprint()
  } catch (err) {
    if (err instanceof MasterKeyConfigurationError) {
      throw secretEncryptionConfigurationError(err)
    }
    throw err
  }

  if (row.key_fingerprint !== currentFingerprint) {
    console.error(
      '[githubPublishSettings] token was encrypted with a different master key — re-enter it in settings.',
    )
    return null
  }

  try {
    return await decryptSecret(masterKey, {
      ciphertext: row.token_ciphertext,
      iv: row.token_iv,
    })
  } catch (err) {
    console.error('[githubPublishSettings] failed to decrypt token:', err)
    return null
  }
}
