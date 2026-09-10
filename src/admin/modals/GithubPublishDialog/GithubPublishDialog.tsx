/**
 * GithubPublishDialog — configure the GitHub Pages target + PAT, then
 * download the local push kit: a ZIP with the basePath-rewritten static
 * export plus push scripts (push.cmd / push.sh) that publish it to GitHub
 * from the operator's machine. The server itself never talks to GitHub —
 * restricted / high-latency server egress to api.github.com is sidestepped
 * entirely.
 *
 * One click saves the settings and downloads the kit (step-up gated). The
 * kit's scripts force-push the export as a full tree replacement, so
 * repeated downloads never conflict with the remote branch tip.
 */
import { useEffect, useId, useState } from 'react'
import {
  downloadGithubPushKit,
  getGithubPublishSettings,
  putGithubPublishSettings,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Switch } from '@ui/components/Switch'
import { pushToast } from '@ui/components/Toast'
import styles from './GithubPublishDialog.module.css'

const FORM_ID = 'github-publish-form'
const DEFAULT_BRANCH = 'gh-pages'
const KIT_FILENAME = 'instatic-push-kit.zip'

interface GithubPublishDialogProps {
  open: boolean
  onClose: () => void
}

interface PublishFormValues {
  repoUrl: string
  branch: string
  basePath: string
  token: string
  hasToken: boolean
  clearToken: boolean
  embedToken: boolean
}

// ---------------------------------------------------------------------------
// Module-level helpers (extracted so the React Compiler can compile the
// component body — try/finally inside an async function prevents compilation).
// ---------------------------------------------------------------------------

function saveBlobToFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function toastKitDownloaded(): void {
  pushToast({
    kind: 'success',
    title: 'Push kit downloaded',
    body: 'Unzip it and double-click push.cmd (or run: bash push.sh) to publish to GitHub Pages.',
    location: 'site-editor',
  })
}

function toastFailure(message: string): void {
  pushToast({
    kind: 'error',
    title: 'Push kit failed',
    body: message,
    location: 'site-editor',
  })
}

async function loadSettings(
  setLoading: (v: boolean) => void,
  setError: (msg: string | null) => void,
  apply: (values: { repoUrl: string; branch: string; basePath: string; hasToken: boolean }) => void,
): Promise<void> {
  setLoading(true)
  setError(null)
  try {
    const settings = await getGithubPublishSettings()
    apply({
      repoUrl: settings.repoUrl,
      branch: settings.branch || DEFAULT_BRANCH,
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

/**
 * Validate the form, persist settings, then download the push kit ZIP
 * (step-up gated) and hand it to the browser as a file save.
 */
async function downloadKitFromForm(
  values: PublishFormValues,
  runStepUp: <T>(action: () => Promise<T>) => Promise<T>,
  setBusy: (v: boolean) => void,
  setError: (msg: string | null) => void,
  setHasToken: (v: boolean) => void,
): Promise<void> {
  const repoUrl = values.repoUrl.trim()
  if (!repoUrl) {
    setError('Repository URL is required.')
    return
  }

  const token = values.token.trim()
  const willHaveToken = values.clearToken ? Boolean(token) : values.hasToken || Boolean(token)
  if (values.embedToken && !willHaveToken) {
    setError('A personal access token is required when embedding it in the push scripts.')
    return
  }

  const branch = values.branch.trim() || DEFAULT_BRANCH
  const basePath = values.basePath.trim()

  const body: { repoUrl: string; branch: string; basePath: string; token?: string } = {
    repoUrl,
    branch,
    basePath,
  }
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

    const blob = await runStepUp(() => downloadGithubPushKit({ embedToken: values.embedToken }))
    saveBlobToFile(blob, KIT_FILENAME)
    toastKitDownloaded()
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) {
      return
    }
    console.error('[GithubPublishDialog]', err)
    const message = getErrorMessage(err, 'Push kit download failed')
    setError(message)
    toastFailure(message)
  } finally {
    setBusy(false)
  }
}

export function GithubPublishDialog({ open, onClose }: GithubPublishDialogProps) {
  const { runStepUp } = useStepUp()
  const repoUrlId = useId()
  const branchId = useId()
  const basePathId = useId()
  const tokenId = useId()
  const embedTokenId = useId()

  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState(DEFAULT_BRANCH)
  const [basePath, setBasePath] = useState('')
  const [token, setToken] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [clearToken, setClearToken] = useState(false)
  const [embedToken, setEmbedToken] = useState(true)

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
        setBasePath(values.basePath)
        setHasToken(values.hasToken)
      },
    )

    return () => {
      cancelled = true
    }
  }, [open])

  async function handleDownload() {
    await downloadKitFromForm(
      { repoUrl, branch, basePath, token, hasToken, clearToken, embedToken },
      runStepUp,
      setBusy,
      setError,
      setHasToken,
    )
  }

  function handleClearToken() {
    setClearToken(true)
    setToken('')
    setError(null)
  }

  const tokenPlaceholder = hasToken && !clearToken ? 'Leave blank to keep' : 'ghp_…'

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
            {busy ? 'Building…' : 'Download push kit'}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void handleDownload()
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
            invalid={Boolean(error && !hasToken && !token.trim() && embedToken)}
          />
        </div>

        <div className={styles.field}>
          <div className={styles.embedRow}>
            <Switch
              id={embedTokenId}
              checked={embedToken}
              onCheckedChange={(value) => {
                setEmbedToken(value)
                setError(null)
              }}
              disabled={busy}
            />
            <label htmlFor={embedTokenId} className={styles.embedLabel}>
              Embed token in the push scripts
            </label>
          </div>
          <p className={styles.hint}>
            Embedded: double-click is all it takes, but the ZIP then carries repository write
            access — do not share it. Without embedding, the first push asks for a GitHub login
            in the browser.
          </p>
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
