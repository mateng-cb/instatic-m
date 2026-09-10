/**
 * PublishingSection — self-hosted CMS publishing details + GitHub Pages defaults.
 *
 * The GitHub Pages block only persists settings/token via
 * `putGithubPublishSettings`. Downloading the push kit runs from the Site
 * editor Publish menu 「Publish to GitHub…」.
 */
import { useEffect, useId, useState } from 'react'
import { useSiteSettingsController } from '../useSiteSettingsController'
import { resolveFrameworkPreferences } from '@core/framework'
import {
  getGithubPublishSettings,
  putGithubPublishSettings,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Switch } from '@ui/components/Switch'
import { Input } from '@ui/components/Input'
import { Button } from '@ui/components/Button'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { pushToast } from '@ui/components/Toast'
import s from '../SettingsModal.module.css'

const DEFAULT_BRANCH = 'gh-pages'

interface GithubFormValues {
  repoUrl: string
  branch: string
  basePath: string
  token: string
  hasToken: boolean
  clearToken: boolean
}

// ---------------------------------------------------------------------------
// Module-level helpers (extracted so the React Compiler can compile the
// component body — try/finally inside an async function prevents compilation).
// ---------------------------------------------------------------------------

async function loadGithubSettings(
  setLoading: (v: boolean) => void,
  setLoadError: (msg: string | null) => void,
  apply: (values: {
    repoUrl: string
    branch: string
    basePath: string
    hasToken: boolean
  }) => void,
): Promise<void> {
  setLoading(true)
  setLoadError(null)
  try {
    const settings = await getGithubPublishSettings()
    apply({
      repoUrl: settings.repoUrl,
      branch: settings.branch || DEFAULT_BRANCH,
      basePath: settings.basePath,
      hasToken: settings.hasToken,
    })
  } catch (err) {
    console.error('[PublishingSection]', err)
    setLoadError(getErrorMessage(err, 'Failed to load GitHub publish settings'))
  } finally {
    setLoading(false)
  }
}

async function saveGithubSettings(
  values: GithubFormValues,
  setSaving: (v: boolean) => void,
  setHasToken: (v: boolean) => void,
  setClearToken: (v: boolean) => void,
  setToken: (v: string) => void,
): Promise<void> {
  const repoUrl = values.repoUrl.trim()
  const branch = values.branch.trim() || DEFAULT_BRANCH
  const basePath = values.basePath.trim()
  const token = values.token.trim()

  const body: {
    repoUrl: string
    branch: string
    basePath: string
    token?: string
  } = { repoUrl, branch, basePath }

  // Omit token to keep; '' to clear; non-empty to rotate.
  if (values.clearToken) {
    body.token = ''
  } else if (token) {
    body.token = token
  }

  setSaving(true)
  try {
    const saved = await putGithubPublishSettings(body)
    setHasToken(saved.hasToken)
    setClearToken(false)
    setToken('')
    pushToast({
      kind: 'success',
      title: 'GitHub Pages settings saved',
      body: 'Defaults and token were updated. Publish from the Publish menu when ready.',
      location: 'settings',
    })
  } catch (err) {
    console.error('[PublishingSection]', err)
    const message = getErrorMessage(err, 'Failed to save GitHub publish settings')
    pushToast({
      kind: 'error',
      title: 'Could not save GitHub Pages settings',
      body: message,
      location: 'settings',
    })
  } finally {
    setSaving(false)
  }
}

export function PublishingSection() {
  const { site, error, updateFrameworkPreferences } = useSiteSettingsController()

  if (error) {
    return <p className={s.sectionDescription} role="alert">{error}</p>
  }

  if (!site) {
    return <SkeletonBlock minHeight={200} ariaLabel="Loading site settings" />
  }

  const frameworkPreferences = resolveFrameworkPreferences(site.settings.framework?.preferences)
  const treeShakeId = 'publishing-tree-shake-framework-utilities'

  return (
    <div>
      <p className={s.sectionDescription}>
        Published pages are served by this self-hosted CMS.
      </p>

      <section aria-labelledby="pub-runtime-heading" className={s.sectionBlock}>
        <h4 id="pub-runtime-heading" className={s.subHeading}>
          Runtime
        </h4>

        <dl className={s.pubRuntimeList}>
          <div>
            <dt>Site</dt>
            <dd>/</dd>
          </div>
          <div>
            <dt>Admin</dt>
            <dd>/admin</dd>
          </div>
          <div>
            <dt>Draft source</dt>
            <dd>Database</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="pub-framework-heading" className={s.sectionBlock}>
        <h4 id="pub-framework-heading" className={s.subHeading}>
          Framework CSS
        </h4>

        <div className={s.cardGroup}>
          <div className={s.toggleRow}>
            <div className={s.toggleRowContent}>
              <label htmlFor={treeShakeId} className={s.toggleRowLabel}>
                Tree-shake generated framework utilities
              </label>
              <p className={s.toggleRowDesc}>
                Emit only generated color, typography, and spacing utility classes used in the page
                and component trees. Turn this off when custom runtime code references generated
                utilities outside the editor tree.
              </p>
            </div>
            <Switch
              id={treeShakeId}
              checked={frameworkPreferences.treeShakeGeneratedFrameworkUtilities}
              onCheckedChange={(value) =>
                updateFrameworkPreferences({ treeShakeGeneratedFrameworkUtilities: value })
              }
            />
          </div>
        </div>
      </section>

      <GithubPagesBlock />
    </div>
  )
}

function GithubPagesBlock() {
  const repoUrlId = useId()
  const branchId = useId()
  const basePathId = useId()
  const tokenId = useId()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState(DEFAULT_BRANCH)
  const [basePath, setBasePath] = useState('')
  const [token, setToken] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [clearToken, setClearToken] = useState(false)

  useEffect(() => {
    let cancelled = false

    void loadGithubSettings(
      (v) => {
        if (!cancelled) setLoading(v)
      },
      (msg) => {
        if (!cancelled) setLoadError(msg)
      },
      (values) => {
        if (cancelled) return
        setRepoUrl(values.repoUrl)
        setBranch(values.branch)
        setBasePath(values.basePath)
        setHasToken(values.hasToken)
        setToken('')
        setClearToken(false)
      },
    )

    return () => {
      cancelled = true
    }
  }, [])

  function handleClearToken() {
    setClearToken(true)
    setToken('')
  }

  function handleSave() {
    void saveGithubSettings(
      { repoUrl, branch, basePath, token, hasToken, clearToken },
      setSaving,
      setHasToken,
      setClearToken,
      setToken,
    )
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
    <section aria-labelledby="pub-github-heading" className={s.sectionBlock}>
      <h4 id="pub-github-heading" className={s.subHeading}>
        GitHub Pages
      </h4>
      <p className={s.preferenceCategoryDesc}>
        Store repository defaults and a personal access token here. Downloading the push kit (the
        static export + scripts that publish it to GitHub from your machine) happens from the
        Publish menu 「Publish to GitHub…」 — this block only saves settings.
      </p>

      {loading ? (
        <SkeletonBlock minHeight={220} ariaLabel="Loading GitHub Pages settings" />
      ) : loadError ? (
        <p className={s.sectionDescription} role="alert">
          {loadError}
        </p>
      ) : (
        <>
          <div className={s.genFieldRow}>
            <label htmlFor={repoUrlId} className={s.label}>
              Repository URL
            </label>
            <Input
              id={repoUrlId}
              type="text"
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
              placeholder="https://github.com/owner/repo"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>

          <div className={s.genFieldRow}>
            <label htmlFor={branchId} className={s.label}>
              Branch
            </label>
            <Input
              id={branchId}
              type="text"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder={DEFAULT_BRANCH}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>

          <div className={s.genFieldRow}>
            <label htmlFor={basePathId} className={s.label}>
              Base path
            </label>
            <Input
              id={basePathId}
              type="text"
              value={basePath}
              onChange={(event) => setBasePath(event.target.value)}
              placeholder="/repo-name"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
            <p className={s.pubFieldHint}>
              Project Pages usually need /repo-name; user/org sites and apex custom domains use
              empty.
            </p>
          </div>

          <div className={s.genFieldRow}>
            <div className={s.pubTokenMeta}>
              <label htmlFor={tokenId} className={s.label}>
                Personal access token
              </label>
              {hasToken && !clearToken && (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={saving}
                  onClick={handleClearToken}
                >
                  Clear token
                </Button>
              )}
            </div>
            {tokenStatusLabel && (
              <p className={s.pubTokenStatus} role="status">
                {tokenStatusLabel}
              </p>
            )}
            <Input
              id={tokenId}
              type="password"
              value={token}
              onChange={(event) => {
                setToken(event.target.value)
                setClearToken(false)
              }}
              placeholder={tokenPlaceholder}
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
            />
          </div>

          <div className={s.pubActions}>
            <Button
              variant="primary"
              size="sm"
              type="button"
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
