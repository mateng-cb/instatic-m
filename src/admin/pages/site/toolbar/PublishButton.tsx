import { useEffect, useRef, useState } from 'react'
import type { SiteDocument } from '@core/page-tree'
import { selectActivePage, useEditorStore } from '@site/store/store'
import {
  downloadStaticExport,
  getCmsPublishStatus,
  publishCmsDraft,
} from '@core/persistence'
import { ApiError } from '@core/http'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import { CalendarSolidIcon } from 'pixel-art-icons/icons/calendar-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { SchedulePublishDialog } from '@admin/modals/SchedulePublishDialog'
import { GithubPublishDialog } from '@admin/modals/GithubPublishDialog'
import type { PersistenceSaveStatus } from '@site/hooks/usePersistence'
import { pushToast } from '@ui/components/Toast'
import { PublishActionGroup, type PublishActionMenuItem } from './PublishActionGroup'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { SiteRuntimeDiagnostic } from '@core/site-runtime'

const STATIC_EXPORT_FILENAME = 'instatic-static-export.zip'

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

type PublishState = 'idle' | 'publishing' | 'published' | 'error'

interface PublishButtonProps {
  enabled?: boolean
  saveStatus?: PersistenceSaveStatus
  runtimeDiagnostics?: SiteRuntimeDiagnostic[]
  runtimeValidationPending?: boolean
}

const EMPTY_RUNTIME_DIAGNOSTICS: SiteRuntimeDiagnostic[] = []

export function PublishButton({
  enabled = true,
  saveStatus,
  runtimeDiagnostics = EMPTY_RUNTIME_DIAGNOSTICS,
  runtimeValidationPending = false,
}: PublishButtonProps) {
  const site = useEditorStore((s) => s.site)
  const siteId = useEditorStore((s) => s.site?.id ?? null)
  const activePage = useEditorStore(selectActivePage)
  const openPreview = useEditorStore((s) => s.openPreview)
  const { runStepUp } = useStepUp()
  const [state, setState] = useState<PublishState>('idle')
  const [exporting, setExporting] = useState(false)
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  const [githubDialogOpen, setGithubDialogOpen] = useState(false)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * The `site` reference captured when the button entered the "published"
   * state. Every store mutation (local or a remote peer's) produces a new
   * reference, so `site !== publishedSiteRef.current` is the exact "the
   * draft moved on since publish" signal that returns the button to idle.
   */
  const publishedSiteRef = useRef<SiteDocument | null>(null)
  const syncError = saveStatus?.state === 'error' ? saveStatus.message ?? 'Sync failed' : null
  const runtimeErrorCount = runtimeDiagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
  const runtimeErrorLabel = `${runtimeErrorCount} code error${runtimeErrorCount === 1 ? '' : 's'}`

  useEffect(() => {
    const timer = statusTimerRef
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  useEffect(() => {
    if (!enabled || !siteId) return
    let cancelled = false

    async function loadPublishStatus() {
      try {
        const status = await getCmsPublishStatus()
        if (cancelled) return
        if (status.draftMatchesPublished) {
          publishedSiteRef.current = useEditorStore.getState().site
          setState('published')
        }
      } catch (err) {
        console.warn('[toolbar] Failed to load publish status:', err)
      }
    }

    void loadPublishStatus()
    return () => {
      cancelled = true
    }
  }, [enabled, siteId])

  useEffect(() => {
    if (state !== 'published' || site === publishedSiteRef.current) return
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = null
    const resetTimer = setTimeout(() => {
      setState('idle')
    }, 0)
    return () => clearTimeout(resetTimer)
  }, [site, state])

  const resetErrorLater = () => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => {
      setState('idle')
      statusTimerRef.current = null
    }, 5000)
  }

  const handlePublish = async () => {
    if (
      !site ||
      !enabled ||
      state === 'publishing' ||
      runtimeErrorCount > 0 ||
      runtimeValidationPending
    ) return

    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current)
      statusTimerRef.current = null
    }

    setState('publishing')

    try {
      // No client-side flush needed: edits stream to the server live, and
      // the publish endpoint flushes the relay's debounced persist itself.
      // Wrap the publish call in `runStepUp` so the StepUpProvider can
      // intercept the server's `step_up_required` 401, prompt the user
      // to re-enter their password, then retry. Publish is the highest-
      // blast-radius site action (one click replaces every public page),
      // which is why the server gates it behind a fresh step-up window
      // in addition to the `pages.publish` capability check.
      await runStepUp(() => publishCmsDraft())
      publishedSiteRef.current = useEditorStore.getState().site
      setState('published')
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) {
        // User dismissed the step-up dialog \u2014 return the button to its
        // resting state without surfacing an error message; this is the
        // same UX every other step-up-gated action uses.
        setState('idle')
        return
      }
      console.error('[toolbar] Publish failed:', err)
      setState('error')
      pushToast({
        kind: 'error',
        title: 'Publish failed',
        body: getErrorMessage(err, 'Unknown publish error'),
        location: 'site-editor',
      })
      resetErrorLater()
    }
  }

  const handleExportStatic = async () => {
    if (!site || !enabled || exporting) return

    try {
      const status = await getCmsPublishStatus()
      if (!status.hasPublishedVersion) {
        pushToast({
          kind: 'error',
          title: 'Export failed',
          body: 'Publish the site first, then export the static snapshot.',
          location: 'site-editor',
        })
        return
      }

      setExporting(true)
      // Same blast radius as publish \u2014 reuse step-up retry for the ZIP download.
      const blob = await runStepUp(() => downloadStaticExport({ pathMode: 'relative' }))
      triggerBlobDownload(blob, STATIC_EXPORT_FILENAME)
      pushToast({
        kind: 'success',
        title: 'Static site exported',
        body: 'Download started. Form submit warnings (if any) are listed in the ZIP manifest.json.',
        location: 'site-editor',
      })
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      console.error('[toolbar] Static export failed:', err)
      const body =
        err instanceof ApiError && err.status === 422
          ? getErrorMessage(err, 'This site has dynamic content that cannot be fully static.')
          : getErrorMessage(err, 'Unknown static export error')
      pushToast({
        kind: 'error',
        title: 'Export failed',
        body,
        location: 'site-editor',
      })
    } finally {
      setExporting(false)
    }
  }

  const isPublishing = state === 'publishing'
  // Block publish until the client is synced: local edits live only in this
  // client's Y docs until they reach the server, and the server-side publish
  // flush can only bake what it has received. Offline/connecting/error \u2192 the
  // status chip states the reason inline (never available-then-blocked). An
  // absent saveStatus (collab info unavailable) doesn't gate.
  const notSynced = saveStatus ? saveStatus.state !== 'synced' : false
  const disabled = (
    !site ||
    !enabled ||
    isPublishing ||
    notSynced ||
    runtimeErrorCount > 0 ||
    runtimeValidationPending
  )
  const label =
    isPublishing ? 'Publishing' :
    state === 'published' ? 'Published' :
    state === 'error' ? 'Retry publish' :
    'Publish'

  const status =
    syncError ? {
      label: 'Sync failed',
      tone: 'danger' as const,
      ariaLabel: syncError,
    } :
    saveStatus?.state === 'offline' ? {
      label: 'Offline \u2014 reconnecting',
      tone: 'warning' as const,
    } :
    saveStatus?.state === 'connecting' || saveStatus?.state === 'loading' ? {
      label: 'Connecting',
      tone: 'neutral' as const,
    } :
    runtimeErrorCount > 0 ? {
      label: runtimeErrorLabel,
      tone: 'danger' as const,
      ariaLabel: `${runtimeErrorLabel}. Resolve the highlighted script errors before publishing.`,
    } :
    runtimeValidationPending ? {
      label: 'Checking code',
      tone: 'neutral' as const,
      ariaLabel: 'Checking runtime scripts before publishing.',
    } :
    {
      label: 'Draft synced',
      tone: 'success' as const,
    }

  const PublishIcon =
    isPublishing ? LoaderIcon :
    state === 'published' ? CheckIcon :
    state === 'error' ? CircleAlertSolidIcon :
    CloudUploadSolidIcon

  const menuItems: PublishActionMenuItem[] = [
    {
      // Per-page scheduling. The Site editor's primary Publish button
      // still publishes ALL draft pages at once (existing behaviour);
      // the schedule action targets the currently-active page only \u2014
      // matching what the user sees in the editor when they make the
      // decision.
      id: 'schedule-publish',
      label: 'Schedule publish\u2026',
      icon: CalendarSolidIcon,
      disabled: !activePage || runtimeErrorCount > 0 || runtimeValidationPending,
      onSelect: () => setScheduleDialogOpen(true),
      testId: 'toolbar-schedule-publish-action',
    },
    {
      id: 'export-static',
      label: exporting ? 'Exporting\u2026' : 'Export static site\u2026',
      icon: exporting ? LoaderIcon : PackageSolidIcon,
      disabled: !site || exporting,
      onSelect: () => {
        void handleExportStatic()
      },
      testId: 'toolbar-export-static-action',
    },
    {
      id: 'publish-github',
      label: 'Publish to GitHub\u2026',
      icon: ExternalLinkSolidIcon,
      disabled: !site,
      onSelect: () => setGithubDialogOpen(true),
      testId: 'toolbar-publish-github-action',
    },
    {
      id: 'preview',
      label: 'Preview page',
      icon: EyeSolidIcon,
      disabled: !site,
      onSelect: () => openPreview(),
      testId: 'toolbar-preview-action',
    },
    // "Open live page" used to live here. It now has a dedicated
    // toolbar icon button (`OpenLivePageButton`) next to the avatar so
    // it's reachable on every admin route \u2014 not just the Site editor.
  ]

  return (
    <>
      <PublishActionGroup
        statusLabel={state === 'published' ? null : status.label}
        statusTone={status.tone}
        statusAriaLabel={status.ariaLabel}
        publishLabel={label}
        publishAriaLabel={
          state === 'published'
            ? 'Published'
            : runtimeErrorCount > 0
              ? `Cannot publish: ${runtimeErrorLabel}`
              : 'Publish site'
        }
        publishTitle={
          state === 'published'
            ? 'Published'
            : runtimeErrorCount > 0
              ? `Resolve ${runtimeErrorLabel} before publishing`
              : 'Publish site'
        }
        publishState={state === 'publishing' ? 'busy' : state === 'published' ? 'success' : state}
        publishBusy={isPublishing}
        publishDisabled={disabled || state === 'published'}
        publishIcon={PublishIcon}
        onPublish={handlePublish}
        menuItems={menuItems}
      />
      {activePage && (
        <SchedulePublishDialog
          open={scheduleDialogOpen}
          onClose={() => setScheduleDialogOpen(false)}
          rowId={activePage.id}
          // The editor's in-memory Page shape doesn't carry the row's
          // scheduledPublishAt \u2014 that lives on the CMS row, not in the
          // site document. Future enhancement: read it from a
          // useCmsPageStatus(activePage.id) hook so re-opening the
          // dialog pre-fills with the current schedule. For now we
          // start fresh on every open.
          currentScheduledAt={null}
          entityLabel="page"
          onScheduled={() => {
            // Re-fetch publish status so the toolbar can transition out
            // of "Draft saved" / "Unsaved" into the published state if
            // the row picked up. Cheap call \u2014 the same endpoint the
            // mount-time useEffect uses.
            void getCmsPublishStatus().catch(() => undefined)
          }}
        />
      )}
      <GithubPublishDialog
        open={githubDialogOpen}
        onClose={() => setGithubDialogOpen(false)}
      />
    </>
  )
}
