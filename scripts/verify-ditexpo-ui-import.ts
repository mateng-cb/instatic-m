/**
 * 浏览器可行性验证：通过 connectOverCDP 连接（本机 Playwright launch 会挂起）。
 *
 * 前置条件：
 *   - `bun run dev` 跑在 :5173 / :3001
 *   - Chrome 开启远程调试（本脚本会自行启动）
 *
 *   bun run scripts/verify-ditexpo-ui-import.ts
 */
import { chromium, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

const ADMIN = 'http://localhost:5173'
const EMAIL = 'admin@ditexpo.local'
const PASSWORD = 'DitexpoVerify1!'
const CDP = 'http://127.0.0.1:9333'
const ZIP = join(import.meta.dir, '../../DITExpohtml/doc/instatic-import-pack/ditexpo-home.zip')
const PACK = join(import.meta.dir, '../../DITExpohtml/doc/instatic-import-pack')
const REPORT = join(PACK, '验证报告-ui-import.json')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

async function waitForCdp(url: string, timeoutMs = 30_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${url}/json/version`)
      if (res.ok) return
    } catch {
      // 重试直到 CDP 就绪
    }
    await Bun.sleep(300)
  }
  throw new Error(`CDP not ready at ${url}`)
}

function launchChrome(): ChildProcess {
  const userData = join(PACK, '.chrome-profile')
  return spawn(
    CHROME,
    [
      `--remote-debugging-port=9333`,
      `--user-data-dir=${userData}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
}

async function login(page: Page) {
  await page.goto(`${ADMIN}/admin`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Admin Login' }).waitFor({ state: 'visible', timeout: 45_000 })
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.getByTestId('account-menu-trigger').waitFor({ state: 'visible', timeout: 60_000 })
}

async function openSiteImport(page: Page) {
  await page.keyboard.press('Control+K')
  const spotlight = page.locator('[cmdk-input], [data-spotlight-input], input[placeholder*="Search" i], input[placeholder*="search" i]').first()
  const hasSpotlight = await spotlight.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
  if (hasSpotlight) {
    await spotlight.fill('Import Site')
    const option = page.getByRole('option', { name: /Import Site/i }).first()
    if (await option.count()) await option.click()
    else await page.keyboard.press('Enter')
  } else {
    await page.goto(`${ADMIN}/admin/data`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /Import site|Import/i }).first().click()
  }
  await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 30_000 })
}

async function maybeCompleteStepUp(page: Page) {
  const dialog = page.getByTestId('step-up-dialog')
  const opened = await dialog.waitFor({ state: 'visible', timeout: 2_500 }).then(() => true, () => false)
  if (!opened) return
  await page.getByTestId('step-up-password').fill(PASSWORD)
  await page.getByTestId('step-up-confirm').click()
  await dialog.waitFor({ state: 'hidden', timeout: 20_000 })
}

async function clickNamed(page: Page, name: RegExp, timeout = 15_000) {
  const btn = page.getByRole('button', { name }).first()
  await btn.waitFor({ state: 'visible', timeout })
  await btn.click()
}

async function main() {
  const chrome = launchChrome()
  const steps: string[] = []
  let browser
  try {
    await waitForCdp(CDP)
    steps.push('cdp-ready')
    browser = await chromium.connectOverCDP(CDP)
    const context = browser.contexts()[0] ?? (await browser.newContext())
    const page = context.pages()[0] ?? (await context.newPage())
    await page.setViewportSize({ width: 1440, height: 900 })

    await login(page)
    steps.push('login-ok')

    await openSiteImport(page)
    steps.push('import-modal-open')

    const fileInput = page.locator('input[type="file"]').first()
    await fileInput.waitFor({ state: 'attached', timeout: 20_000 })
    await fileInput.setInputFiles(ZIP)
    steps.push('zip-uploaded')

    // 分析约 20MB 的包可能较慢
    await clickNamed(page, /Continue\s*→|Continue/i, 180_000)
    steps.push('clicked-continue')

    // 有冲突则 Conflicts → Import；否则直接 Import
    const importBtn = page.getByRole('button', { name: /^Import$/i }).first()
    const hasImport = await importBtn.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false)
    if (hasImport) {
      await importBtn.click()
      steps.push('clicked-import')
    } else {
      steps.push('import-button-missing')
    }

    const openSite = page.getByRole('button', { name: /Open site\s*→|Open site/i })
    const done = await openSite.waitFor({ state: 'visible', timeout: 420_000 }).then(() => true, () => false)
    if (!done) {
      await page.screenshot({ path: join(PACK, 'ui-import-failure.png'), fullPage: true })
      throw new Error(`Import did not finish. steps=${steps.join(',')}`)
    }
    steps.push('import-done')
    await openSite.click()
    steps.push('opened-site-from-modal')
    await page.waitForTimeout(3000)

    const publishBtn = page.getByRole('button', { name: /^Publish$|发布/i }).first()
    if (await publishBtn.count()) {
      await publishBtn.click()
      await maybeCompleteStepUp(page)
      const confirm = page.getByRole('button', { name: /^Publish$|Confirm|发布/i }).last()
      if (await confirm.isVisible().catch(() => false)) {
        await confirm.click().catch(() => {})
        await maybeCompleteStepUp(page)
      }
      await page.waitForTimeout(5000)
      steps.push('publish-clicked')
    } else {
      steps.push('publish-button-missing')
    }

    const pub = await fetch('http://localhost:3001/')
    const status = pub.status
    const html = await pub.text()
    const hasDitexpo = /DITExpo|数字基础设施/i.test(html)

    const report = {
      ok: status === 200 && hasDitexpo,
      status,
      hasDitexpo,
      htmlLength: html.length,
      steps,
      snippet: html.slice(0, 800),
      at: new Date().toISOString(),
    }
    await Bun.write(REPORT, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exit(2)
  } catch (err) {
    const report = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      steps,
      at: new Date().toISOString(),
    }
    await Bun.write(REPORT, JSON.stringify(report, null, 2))
    console.error(JSON.stringify(report, null, 2))
    process.exit(1)
  } finally {
    try { await browser?.close() } catch { /* ignore */ }
    try { chrome.kill() } catch { /* ignore */ }
  }
}

main()
