/**
 * GithubPublishDialog — confirm-and-track dialog for the GitHub Pages push.
 *
 * Configuration lives in Settings → Publishing (PublishingSection). Opening
 * this dialog loads the stored settings read-only: the confirm view shows the
 * target repo / branch / token status — with a jump to Settings when
 * unconfigured — and Publish starts the export + push job (step-up gated)
 * using the stored settings. The dialog saves nothing.
 *
 * The publish POST returns 202 immediately (a full-site push runs minutes —
 * longer than reverse-proxy timeouts), so the dialog polls the job endpoint
 * until it settles and toasts the outcome. Opening the dialog while a job is
 * running skips the confirm view and shows live progress. Closing mid-run is
 * allowed — the job continues server-side, its outcome arrives via toast, and
 * reopening adopts the running job again.
 */
import { useEffect, useState } from 'react'
import {
  getGithubPublishJob,
  getGithubPublishSettings,
  startGithubPublish,
} from '@core/persistence'
import type { GithubPublishJob } from '@core/persistence'
import { ApiError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useAdminUi } from '@admin/state/adminUi'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import styles from './GithubPublishDialog.module.css'

const DEFAULT_BRANCH = 'gh-pages'
/** Poll cadence for the background job; the push itself is minutes-long. */
const JOB_POLL_INTERVAL_MS = 1000

interface GithubPublishDialogProps {
  open: boolean
  onClose: () => void
}

/** Read-only slice of the stored GitHub publish settings this dialog shows. */
interface SettingsView {
  repoUrl: string
  branch: string
  hasToken: boolean
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
  apply: (values: SettingsView) => void,
): Promise<void> {
  setLoading(true)
  setError(null)
  try {
    const settings = await getGithubPublishSettings()
    apply({
      repoUrl: settings.repoUrl,
      branch: settings.branch || DEFAULT_BRANCH,
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
 * Start the background job (step-up gated) using the stored settings — no
 * body overrides; the server falls back to them. The job's outcome arrives
 * via the polling effect; this only switches the dialog into its running
 * state.
 */
async function startPublish(
  runStepUp: <T>(action: () => Promise<T>) => Promise<T>,
  setBusy: (v: boolean) => void,
  setError: (msg: string | null) => void,
  setMyStartedAt: (v: number | null) => void,
): Promise<void> {
  setBusy(true)
  setError(null)
  // Cleared until the POST returns our job's identity — while null, the
  // poller shows progress but never settles (the registry may still hold the
  // PREVIOUS run's failed/succeeded view until our own job claims the slot).
  setMyStartedAt(null)
  try {
    const res = await runStepUp(() => startGithubPublish())
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

/** Missing repository or token blocks a publish; the fix lives in Settings. */
function isUnconfigured(settings: SettingsView): boolean {
  return !settings.repoUrl || !settings.hasToken
}

export function GithubPublishDialog({ open, onClose }: GithubPublishDialogProps) {
  const { runStepUp } = useStepUp()
  const openSettings = useAdminUi((s) => s.openSettings)

  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<GithubPublishJob | null>(null)
  /** Identity (startedAt) of the job this dialog session tracks; null while
   * our own POST is still in flight — then the poller must not settle. */
  const [myStartedAt, setMyStartedAt] = useState<number | null>(null)

  const [settings, setSettings] = useState<SettingsView>({
    repoUrl: '',
    branch: DEFAULT_BRANCH,
    hasToken: false,
  })

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
        setSettings(values)
      },
    )

    // Adopt an already-running job (another editor started it, or this dialog
    // was reopened mid-run): skip the confirm view, show its progress.
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
          // While our own POST is still in flight (myStartedAt === null) NO
          // view can settle this dialog: { job: null } is just an empty
          // registry (fresh server, POST not yet arrived), and a settled view
          // is the PREVIOUS run's leftover. Show running progress only.
          if (myStartedAt === null) {
            if (current?.state === 'running') setJob(current)
            return
          }
          // We held a job identity and it vanished — the in-memory registry
          // was lost to a server restart mid-run. Surface it as an
          // interruption, not a hang.
          if (current === null) {
            settle(() => {
              setBusy(false)
              setMyStartedAt(null)
              setError('The publish job was interrupted — the server restarted while it was running.')
              toastPublishFailure('Publish interrupted (server restarted)')
            })
            return
          }
          // Only OUR job settles this dialog. A view with a different
          // startedAt is not ours: a settled one is the previous run's
          // leftover, a running one is someone else's job. Show progress for
          // the latter, never settle on either.
          if (current.startedAt !== myStartedAt) {
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
    await startPublish(runStepUp, setBusy, setError, setMyStartedAt)
  }

  function handleOpenSettings() {
    onClose()
    openSettings('publishing')
  }

  const unconfigured = isUnconfigured(settings)
  const progress = busy && job ? jobLabel(job) : null

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Publish to GitHub"
      eyebrow="Static export"
      size="sm"
      loading={loading}
    >
      {busy ? (
        <div className={styles.progressView}>
          <p role="status" className={styles.progress}>
            {progress ?? 'Publishing…'}
          </p>
          <p className={styles.hint}>
            You can close this dialog — the push keeps running and you'll be
            notified of the outcome.
          </p>
        </div>
      ) : (
        <>
          <div className={styles.summary}>
            <div className={styles.row}>
              <span className={styles.label}>Repository</span>
              <span className={styles.value}>
                {settings.repoUrl || 'Not configured'}
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>Branch</span>
              <span className={styles.value}>{settings.branch}</span>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>Token</span>
              <span className={styles.value}>
                {settings.hasToken ? 'Saved' : 'Not configured'}
              </span>
            </div>
          </div>
          {unconfigured && (
            <p role="status" className={styles.hint}>
              Configure the repository and token in Settings → Publishing
              before publishing.
            </p>
          )}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className={styles.actions}>
            {unconfigured ? (
              <Button variant="primary" size="sm" onClick={handleOpenSettings}>
                Open Settings
              </Button>
            ) : (
              <>
                <Button variant="secondary" size="sm" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={loading}
                  onClick={() => void handlePublish()}
                >
                  Publish
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </Dialog>
  )
}
