/**
 * GithubPublishDialog — configure GitHub Pages target + PAT, then push the
 * published static export via `publishToGithub` (step-up gated).
 *
 * Opened from the Site editor Publish menu. Settings are loaded on open and
 * persisted with `putGithubPublishSettings` before the push so one Publish
 * click both saves defaults and ships.
 */
import { useEffect, useId, useState } from 'react'
import {
  getGithubPublishSettings,
  publishToGithub,
  putGithubPublishSettings,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import styles from './GithubPublishDialog.module.css'

const FORM_ID = 'github-publish-form'
const DEFAULT_BRANCH = 'gh-pages'

interface GithubPublishDialogProps {
  open: boolean
  onClose: () => void
}

interface PublishFormValues {
  repoUrl: string
  branch: string
  targetDir: string
  basePath: string
  token: string
  hasToken: boolean
  clearToken: boolean
}

type PublishResult = Awaited<ReturnType<typeof publishToGithub>>

// ---------------------------------------------------------------------------
// Module-level helpers (extracted so the React Compiler can compile the
// component body — try/finally inside an async function prevents compilation).
// ---------------------------------------------------------------------------

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function commitUrlFor(owner: string, repo: string, sha: string): string | null {
  if (!owner || !repo || !sha) return null
  return `https://github.com/${owner}/${repo}/commit/${sha}`
}

function toastPublishSuccess(
  result: PublishResult,
  owner: string,
  repo: string,
): void {
  const sha = shortSha(result.commitSha)
  const url = commitUrlFor(owner, repo, result.commitSha)
  pushToast({
    kind: 'success',
    title: 'Published to GitHub',
    body: url ? `Commit ${sha} — ${url}` : `Commit ${sha}`,
    location: 'site-editor',
  })

  const warnings = result.report.filter((item) => item.severity === 'warning')
  if (warnings.length === 0) return
  pushToast({
    kind: 'warning',
    title: 'Export warnings',
    body: warnings.map((w) => w.message).slice(0, 3).join(' · '),
    location: 'site-editor',
  })
}

async function loadSettings(
  setLoading: (v: boolean) => void,
  setError: (msg: string | null) => void,
  apply: (values: {
    repoUrl: string
    branch: string
    targetDir: string
    basePath: string
    hasToken: boolean
  }) => void,
): Promise<void> {
  setLoading(true)
  setError(null)
  try {
    const settings = await getGithubPublishSettings()
    apply({
      repoUrl: settings.repoUrl,
      branch: settings.branch || DEFAULT_BRANCH,
      targetDir: settings.targetDir,
      basePath: settings.basePath,
      hasToken: settings.hasToken,
    })
  } catch (err) {
    console.error('[GithubPublishDialog]', err)
    setError(getErrorMessage(err, 'Failed to load GitHub publish settings'))
  } finally {
    setLoading(false)
  }
}

async function runGithubPublish(
  values: PublishFormValues,
  runStepUp: <T>(action: () => Promise<T>) => Promise<T>,
  setBusy: (v: boolean) => void,
  setError: (msg: string | null) => void,
  setHasToken: (v: boolean) => void,
  onClose: () => void,
): Promise<void> {
  const repoUrl = values.repoUrl.trim()
  if (!repoUrl) {
    setError('Repository URL is required.')
    return
  }

  const token = values.token.trim()
  // Need a PAT when none is stored yet, or when the user opted to clear the saved one.
  if ((!values.hasToken || values.clearToken) && !token) {
    setError('A personal access token is required.')
    return
  }

  const branch = values.branch.trim() || DEFAULT_BRANCH
  const targetDir = values.targetDir.trim()
  const basePath = values.basePath.trim()

  const body: {
    repoUrl: string
    branch: string
    targetDir: string
    basePath: string
    token?: string
  } = { repoUrl, branch, targetDir, basePath }

  if (values.clearToken) {
    body.token = ''
  } else if (token) {
    body.token = token
  }

  setBusy(true)
  setError(null)
  try {
    const saved = await putGithubPublishSettings(body)
    setHasToken(saved.hasToken)

    const result = await runStepUp(() =>
      publishToGithub({ branch, targetDir, basePath }),
    )

    toastPublishSuccess(result, saved.owner, saved.repo)
    onClose()
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) return
    console.error('[GithubPublishDialog]', err)
    const message = getErrorMessage(err, 'GitHub publish failed')
    setError(message)
    pushToast({
      kind: 'error',
      title: 'GitHub publish failed',
      body: message,
      location: 'site-editor',
    })
  } finally {
    setBusy(false)
  }
}

export function GithubPublishDialog({ open, onClose }: GithubPublishDialogProps) {
  const { runStepUp } = useStepUp()
  const repoUrlId = useId()
  const branchId = useId()
  const targetDirId = useId()
  const basePathId = useId()
  const tokenId = useId()

  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState(DEFAULT_BRANCH)
  const [targetDir, setTargetDir] = useState('')
  const [basePath, setBasePath] = useState('')
  const [token, setToken] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [clearToken, setClearToken] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void loadSettings(
      (v) => {
        if (!cancelled) setLoading(v)
      },
      (msg) => {
        if (!cancelled) setError(msg)
      },
      (values) => {
        if (cancelled) return
        setToken('')
        setClearToken(false)
        setRepoUrl(values.repoUrl)
        setBranch(values.branch)
        setTargetDir(values.targetDir)
        setBasePath(values.basePath)
        setHasToken(values.hasToken)
      },
    )

    return () => {
      cancelled = true
    }
  }, [open])

  async function handlePublish() {
    await runGithubPublish(
      { repoUrl, branch, targetDir, basePath, token, hasToken, clearToken },
      runStepUp,
      setBusy,
      setError,
      setHasToken,
      onClose,
    )
  }

  function handleClearToken() {
    setClearToken(true)
    setToken('')
    setError(null)
  }

  const tokenPlaceholder = hasToken && !clearToken
    ? 'Leave blank to keep'
    : 'ghp_…'

  const tokenStatusLabel = clearToken
    ? 'Token will be cleared on save'
    : hasToken
      ? 'Token saved'
      : null

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Publish to GitHub"
      eyebrow="Static export"
      size="lg"
      loading={loading}
      closeOnEscape={!busy}
      closeOnBackdrop={!busy}
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={FORM_ID}
            disabled={busy || loading}
          >
            {busy ? 'Publishing…' : 'Publish'}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void handlePublish()
        }}
      >
        <div className={styles.field}>
          <label htmlFor={repoUrlId} className={styles.label}>
            Repository URL
          </label>
          <Input
            id={repoUrlId}
            fieldSize="sm"
            value={repoUrl}
            onChange={(event) => {
              setRepoUrl(event.target.value)
              setError(null)
            }}
            placeholder="https://github.com/owner/repo"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            invalid={Boolean(error && !repoUrl.trim())}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor={branchId} className={styles.label}>
            Branch
          </label>
          <Input
            id={branchId}
            fieldSize="sm"
            value={branch}
            onChange={(event) => {
              setBranch(event.target.value)
              setError(null)
            }}
            placeholder={DEFAULT_BRANCH}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor={targetDirId} className={styles.label}>
            Target directory
          </label>
          <Input
            id={targetDirId}
            fieldSize="sm"
            value={targetDir}
            onChange={(event) => {
              setTargetDir(event.target.value)
              setError(null)
            }}
            placeholder="docs (empty = branch root)"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor={basePathId} className={styles.label}>
            Base path
          </label>
          <Input
            id={basePathId}
            fieldSize="sm"
            value={basePath}
            onChange={(event) => {
              setBasePath(event.target.value)
              setError(null)
            }}
            placeholder="/repo-name"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <p className={styles.hint}>
            Project Pages usually need /repo-name; user/org sites and apex custom domains use empty.
          </p>
        </div>

        <div className={styles.field}>
          <div className={styles.tokenMeta}>
            <label htmlFor={tokenId} className={styles.label}>
              Personal access token
            </label>
            {hasToken && !clearToken && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={busy}
                onClick={handleClearToken}
              >
                Clear token
              </Button>
            )}
          </div>
          {tokenStatusLabel && (
            <p className={styles.tokenStatus} role="status">
              {tokenStatusLabel}
            </p>
          )}
          <Input
            id={tokenId}
            fieldSize="sm"
            type="password"
            value={token}
            onChange={(event) => {
              setToken(event.target.value)
              setClearToken(false)
              setError(null)
            }}
            placeholder={tokenPlaceholder}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            invalid={Boolean(error && !hasToken && !token.trim())}
          />
        </div>

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}
