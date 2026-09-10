/**
 * GithubPublishDialog — configure GitHub Pages target + PAT, then start the
 * static-export + Git Data API push as a background job (step-up gated).
 *
 * Opened from the Site editor Publish menu. Settings are loaded on open and
 * persisted with `putGithubPublishSettings` before the push so one Publish
 * click both saves defaults and ships.
 *
 * The publish POST returns 202 immediately (a full-site push runs minutes —
 * longer than reverse-proxy timeouts), so the dialog polls the job endpoint
 * until it settles and toasts the outcome. Opening the dialog while a job is
 * running adopts it: the form locks and shows the same live progress.
 */
import { useEffect, useId, useState } from 'react'
import {
  getGithubPublishJob,
  getGithubPublishSettings,
  putGithubPublishSettings,
  startGithubPublish,
} from '@core/persistence'
import type { GithubPublishJob } from '@core/persistence'
import { ApiError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import styles from './GithubPublishDialog.module.css'

const FORM_ID = 'github-publish-form'
const DEFAULT_BRANCH = 'gh-pages'
/** Mirrors the server-side default in server/github/gitCliPush.ts. */
const DEFAULT_COMMIT_MESSAGE = 'Publish site from Instatic'
/** Poll cadence for the background job; the push itself is minutes-long. */
const JOB_POLL_INTERVAL_MS = 1000

interface GithubPublishDialogProps {
  open: boolean
  onClose: () => void
}

interface PublishFormValues {
  repoUrl: string
  branch: string
  targetDir: string
  basePath: string
  commitMessage: string
  token: string
  hasToken: boolean
  clearToken: boolean
}

type PublishResult = NonNullable<GithubPublishJob['result']>

// ---------------------------------------------------------------------------
// Module-level helpers (extracted so the React Compiler can compile the
// component body — try/finally inside an async function prevents compilation).
// ---------------------------------------------------------------------------

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** Human label for a running job; null → nothing to show. */
function jobLabel(job: GithubPublishJob): string | null {
  if (job.state !== 'running') return null
  if (job.phase === 'exporting') return 'Preparing export…'
  if (job.phase === 'uploading') {
    const base = `Uploading files ${job.uploaded}/${job.total}`
    return job.currentPath ? `${base} — ${job.currentPath}` : base
  }
  if (job.phase === 'finalizing') return 'Creating commit on GitHub…'
  return null
}

function commitUrlFor(repoUrl: string, sha: string): string | null {
  if (!repoUrl || !sha) return null
  return `${repoUrl.replace(/\/+$/, '')}/commit/${sha}`
}

function toastPublishSuccess(result: PublishResult): void {
  const sha = shortSha(result.commitSha)
  const url = commitUrlFor(result.repoUrl, result.commitSha)
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

function toastPublishFailure(message: string): void {
  pushToast({
    kind: 'error',
    title: 'GitHub publish failed',
    body: message,
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

/**
 * Validate the form, persist settings, start the background job (step-up
 * gated). The job's outcome arrives via the polling effect — this only
 * switches the dialog into its running state.
 */
async function startPublishFromForm(
  values: PublishFormValues,
  runStepUp: <T>(action: () => Promise<T>) => Promise<T>,
  setBusy: (v: boolean) => void,
  setError: (msg: string | null) => void,
  setHasToken: (v: boolean) => void,
  setJob: (job: GithubPublishJob | null) => void,
  setMyStartedAt: (v: number | null) => void,
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
  const commitMessage = values.commitMessage.trim()

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
  setJob(null)
  // Cleared until the POST returns our job's identity — while null, the
  // poller shows progress but never settles (the registry may still hold the
  // PREVIOUS run's failed/succeeded view until our own job claims the slot).
  setMyStartedAt(null)
  try {
    const saved = await putGithubPublishSettings(body)
    setHasToken(saved.hasToken)

    const res = await runStepUp(() =>
      startGithubPublish({
        branch,
        targetDir,
        basePath,
        ...(commitMessage ? { commitMessage } : {}),
      }),
    )
    setMyStartedAt(res.startedAt)
    // Job accepted (202). The polling effect now drives progress + outcome.
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) {
      setBusy(false)
      return
    }
    // 409: a job is already running (this dialog or another tab started it).
    // Adopt it — show its progress instead of a dead-end error.
    if (err instanceof ApiError && err.status === 409) {
      try {
        const running = await getGithubPublishJob()
        if (running.job?.state === 'running') {
          setMyStartedAt(running.job.startedAt)
          return // stay busy; the polling effect takes over
        }
      } catch (_adoptErr) {
        // Best-effort adoption; fall through to the plain error below.
      }
    }
    console.error('[GithubPublishDialog]', err)
    const message = getErrorMessage(err, 'GitHub publish failed')
    setError(message)
    toastPublishFailure(message)
    setBusy(false)
  }
}

export function GithubPublishDialog({ open, onClose }: GithubPublishDialogProps) {
  const { runStepUp } = useStepUp()
  const repoUrlId = useId()
  const branchId = useId()
  const targetDirId = useId()
  const basePathId = useId()
  const commitMessageId = useId()
  const tokenId = useId()

  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<GithubPublishJob | null>(null)
  /** Identity (startedAt) of the job this dialog session tracks; null while
   * our own POST is still in flight — then the poller must not settle. */
  const [myStartedAt, setMyStartedAt] = useState<number | null>(null)

  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState(DEFAULT_BRANCH)
  const [targetDir, setTargetDir] = useState('')
  const [basePath, setBasePath] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
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

    // Adopt an already-running job (another editor started it, or this dialog
    // was reopened mid-run) so the dialog shows its progress and outcome too.
    void getGithubPublishJob()
      .then((res) => {
        if (!cancelled && res.job?.state === 'running') {
          setMyStartedAt(res.job.startedAt)
          setBusy(true)
        }
      })
      .catch((_err) => {
        // Best-effort adoption; a failure here never blocks a new publish.
      })

    return () => {
      cancelled = true
    }
  }, [open])

  // Poll the job endpoint while a publish is running; settle on the outcome.
  useEffect(() => {
    if (!busy) return
    let cancelled = false
    let settled = false

    const settle = (finalize: () => void) => {
      if (settled || cancelled) return
      settled = true
      clearInterval(interval)
      finalize()
    }

    const poll = () => {
      void getGithubPublishJob()
        .then((res) => {
          if (cancelled) return
          const current = res.job
          // A vanished job means the server restarted mid-run (in-memory
          // registry) — surface it as an interruption, not a hang.
          if (current === null) {
            settle(() => {
              setBusy(false)
              setMyStartedAt(null)
              setError('The publish job was interrupted — the server restarted while it was running.')
              toastPublishFailure('Publish interrupted (server restarted)')
            })
            return
          }
          // Only OUR job settles this dialog. A settled view with a different
          // startedAt is the previous run's leftover (ours hasn't claimed the
          // slot yet — e.g. the POST is still behind step-up); a running view
          // with a different startedAt is someone else's job. Show progress
          // for the latter, never settle on either.
          if (myStartedAt !== null && current.startedAt !== myStartedAt) {
            if (current.state === 'running') setJob(current)
            return
          }
          setJob(current)
          if (current.state === 'succeeded' && current.result) {
            const result = current.result
            settle(() => {
              setBusy(false)
              setMyStartedAt(null)
              toastPublishSuccess(result)
              onClose()
            })
          } else if (current.state === 'failed') {
            settle(() => {
              const message = current.failure?.message ?? 'GitHub publish failed'
              setBusy(false)
              setMyStartedAt(null)
              setError(message)
              toastPublishFailure(message)
            })
          }
        })
        .catch((_err) => {
          // Transient poll failures keep polling; only a settled job or an
          // interruption ends the loop.
        })
    }

    const interval = setInterval(poll, JOB_POLL_INTERVAL_MS)
    poll()
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [busy, myStartedAt, onClose])

  async function handlePublish() {
    await startPublishFromForm(
      { repoUrl, branch, targetDir, basePath, commitMessage, token, hasToken, clearToken },
      runStepUp,
      setBusy,
      setError,
      setHasToken,
      setJob,
      setMyStartedAt,
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
          <label htmlFor={commitMessageId} className={styles.label}>
            Commit message
          </label>
          <Input
            id={commitMessageId}
            fieldSize="sm"
            value={commitMessage}
            onChange={(event) => {
              setCommitMessage(event.target.value)
              setError(null)
            }}
            placeholder={DEFAULT_COMMIT_MESSAGE}
            maxLength={280}
            autoComplete="off"
            disabled={busy}
          />
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

        {busy && job && jobLabel(job) && (
          <p role="status" className={styles.progress}>
            {jobLabel(job)}
          </p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}
