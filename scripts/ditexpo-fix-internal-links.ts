/**
 * 修正导入后的站内死链：HTML 导入保留源站的 `xxx.html` 相对链接，而 Instatic
 * 的公开路由是 `/xxx`（实测 `/conference.html` → 404）。本脚本遍历站点全部页面
 * 节点，把指向本站 slug 的 `.html` 链接改写为干净路径，保存并发布后逐页验证
 * 发布 HTML 中不再残留站内 `.html` 链接。
 *
 *   bun run scripts/ditexpo-fix-internal-links.ts
 *
 * 已知边界：仅改写「恰好匹配本站 slug」的链接；外链（https://、电子书等）、
 * 锚点、mailto/tel 不动。导入器自动改写内链属引擎级改进，另行提交。
 */
import { join } from 'node:path'
import { pageFromRow } from '../src/core/data/pageFromRow'
import { visualComponentFromRow } from '../src/core/data/componentFromRow'
import { savedLayoutFromRow } from '../src/core/data/layoutFromRow'
import type { PageNode, SiteDocument } from '@core/page-tree'

const API = 'http://localhost:3001/admin/api/cms'
const EMAIL = 'admin@ditexpo.local'
const PASSWORD = 'DitexpoVerify1!'
const REPORT = join(
  import.meta.dir,
  '../../DITExpohtml/doc/instatic-import-pack/验证报告-internal-links.json',
)

class CookieJar {
  private cookies = new Map<string, string>()
  absorb(res: Response) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    const list = raw.length ? raw : ([res.headers.get('set-cookie')].filter(Boolean) as string[])
    for (const line of list) {
      const part = line.split(';')[0]!
      const eq = part.indexOf('=')
      if (eq > 0) this.cookies.set(part.slice(0, eq), part.slice(eq + 1))
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

async function api(jar: CookieJar, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const cookie = jar.header()
  if (cookie) headers.set('cookie', cookie)
  const res = await fetch(`${API}${path}`, { ...init, headers })
  jar.absorb(res)
  return res
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * `./news.html` / `news.html` / `news.html#top` → `/news`（index → `/`）。
 * 非本站 slug 或非内部链接返回 null（不改写）。
 */
function rewriteHref(href: string, slugs: Set<string>): string | null {
  if (!href || /^[a-z][\w+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) {
    return null
  }
  const match = href.replace(/^\.\//, '').match(/^([\w-]+)\.html(?:#(.*))?$/)
  if (!match) return null
  const [, slug, anchor] = match
  if (!slugs.has(slug)) return null
  const base = slug === 'index' ? '/' : `/${slug}`
  return anchor ? `${base}#${anchor}` : base
}

function fixInternalLinks(site: SiteDocument, steps: string[]): number {
  const slugs = new Set(site.pages.map((p) => p.slug))
  let changed = 0
  const perPage: string[] = []

  for (const page of site.pages) {
    let pageChanged = 0
    for (const node of Object.values(page.nodes) as PageNode[]) {
      const props = node.props as Record<string, unknown> | undefined
      if (!isRecord(props)) continue
      for (const holder of [props, isRecord(props.htmlAttributes) ? props.htmlAttributes : null]) {
        if (!holder || typeof holder.href !== 'string') continue
        const next = rewriteHref(holder.href, slugs)
        if (next !== null && next !== holder.href) {
          holder.href = next
          changed++
          pageChanged++
        }
      }
    }
    if (pageChanged > 0) perPage.push(`${page.slug}:${pageChanged}`)
  }

  steps.push(`rewritten links=${changed} (${perPage.join(', ') || 'none'})`)
  return changed
}

async function main() {
  const steps: string[] = []
  const t0 = performance.now()
  const jar = new CookieJar()

  {
    const res = await api(jar, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
    if (!res.ok) throw new Error(`login failed ${res.status}`)
    steps.push('login-ok')
  }

  const [shellRes, pagesRes, componentsRes, layoutsRes] = await Promise.all([
    api(jar, '/site'),
    api(jar, '/pages'),
    api(jar, '/components'),
    api(jar, '/layouts'),
  ])
  if (!shellRes.ok || !pagesRes.ok) throw new Error('load failed')

  const shellBody = (await shellRes.json()) as {
    site: Omit<SiteDocument, 'pages' | 'visualComponents' | 'layouts'>
    seq: number
  }
  const pagesBody = (await pagesRes.json()) as { rows: unknown[] }
  const componentsBody = componentsRes.ok
    ? ((await componentsRes.json()) as { rows: unknown[] })
    : { rows: [] }
  const layoutsBody = layoutsRes.ok
    ? ((await layoutsRes.json()) as { rows: unknown[] })
    : { rows: [] }

  const site: SiteDocument = {
    ...(shellBody.site as SiteDocument),
    pages: pagesBody.rows.map((row) => pageFromRow(row as never)).filter(Boolean) as SiteDocument['pages'],
    visualComponents: componentsBody.rows
      .map((row) => visualComponentFromRow(row as never))
      .filter(Boolean) as SiteDocument['visualComponents'],
    layouts: layoutsBody.rows
      .map((row) => savedLayoutFromRow(row as never))
      .filter(Boolean) as SiteDocument['layouts'],
  }

  const changed = fixInternalLinks(site, steps)

  const { pages: savedPages, visualComponents: vcs, layouts: savedLayouts, ...shell } = site
  const saveRes = await api(jar, '/site-document', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'replace',
      site: shell,
      changedPages: savedPages,
      deletedPageIds: [],
      changedComponents: vcs,
      deletedComponentIds: [],
      changedLayouts: savedLayouts,
      deletedLayoutIds: [],
      baseSeqs: {},
      shellBaseSeq: shellBody.seq ?? 0,
    }),
  })
  if (!saveRes.ok) throw new Error(`save failed ${saveRes.status} ${await saveRes.text()}`)
  steps.push('site-document-saved')

  const stepUp = await api(jar, '/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  if (!stepUp.ok) throw new Error(`step-up failed ${stepUp.status}`)
  steps.push('step-up-ok')

  const pubRes = await api(jar, '/publish', { method: 'POST' })
  if (!pubRes.ok) throw new Error(`publish failed ${pubRes.status} ${await pubRes.text()}`)
  steps.push(`publish-ok ${JSON.stringify(await pubRes.json())}`)

  // 逐页验证：发布 HTML 中不得再有站内 .html 链接（外链 https:// 排除）。
  const deadLinks: Record<string, string[]> = {}
  const statuses: Record<string, number> = {}
  for (const page of site.pages) {
    const url = `http://localhost:3001${page.slug === 'index' ? '/' : `/${page.slug}`}`
    const res = await fetch(url)
    statuses[page.slug] = res.status
    const html = await res.text()
    const bad = [...html.matchAll(/href="([^"]*\.html[^"]*)"/g)]
      .map((m) => m[1]!)
      .filter((h) => !/^https?:\/\//.test(h))
    if (bad.length > 0) deadLinks[page.slug] = [...new Set(bad)]
  }

  const report = {
    ok: Object.keys(deadLinks).length === 0 && Object.values(statuses).every((s) => s === 200),
    linksRewritten: changed,
    deadLinksRemaining: deadLinks,
    pageStatuses: statuses,
    durationMs: Math.round(performance.now() - t0),
    steps,
    at: new Date().toISOString(),
  }
  await Bun.write(REPORT, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exit(2)
}

main().catch(async (err) => {
  const report = {
    ok: false,
    error: err instanceof Error ? err.stack ?? err.message : String(err),
    at: new Date().toISOString(),
  }
  await Bun.write(REPORT, JSON.stringify(report, null, 2))
  console.error(JSON.stringify(report, null, 2))
  process.exit(1)
})
