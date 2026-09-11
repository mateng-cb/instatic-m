/**
 * 修正导入后的站内死链：HTML 导入保留源站的 `xxx.html` 相对链接，而 Instatic
 * 的公开路由是 `/xxx`（实测 `/conference.html` → 404）。本脚本遍历站点全部页面
 * 节点，把指向本站 slug 的 `.html` 链接改写为干净路径，保存并发布后逐页验证
 * 发布 HTML 中不再残留站内 `.html` 链接。
 *
 *   INSTATIC_EMAIL=… INSTATIC_PASSWORD=… bun run scripts/ditexpo-fix-internal-links.ts \
 *     [--api http://localhost:3001]
 *
 * 端点与凭据见 scripts/lib/cmsClient.ts（--api/--email/--password 或
 * INSTATIC_API/INSTATIC_EMAIL/INSTATIC_PASSWORD 环境变量）。
 *
 * 已知边界：仅改写「恰好匹配本站 slug」的链接；外链（https://、电子书等）、
 * 锚点、mailto/tel 不动。导入器自动改写内链属引擎级改进，另行提交。
 */
import { join } from 'node:path'
import type { PageNode, SiteDocument } from '@core/page-tree'
import { CmsClient, takeEndpointArgs } from './lib/cmsClient'

const REPORT = join(
  import.meta.dir,
  '../../DITExpohtml/doc/instatic-import-pack/验证报告-internal-links.json',
)

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
  const { endpoint } = takeEndpointArgs(process.argv.slice(2))
  const client = new CmsClient(endpoint)
  const steps: string[] = []
  const t0 = performance.now()

  await client.login()
  steps.push('login-ok')
  const { site, seq } = await client.loadSite()

  const changed = fixInternalLinks(site, steps)

  await client.saveSite(site, seq)
  steps.push('site-document-saved')

  await client.stepUp()
  steps.push('step-up-ok')

  const pubJson = await client.publish()
  steps.push(`publish-ok ${JSON.stringify(pubJson)}`)

  // 逐页验证：发布 HTML 中不得再有站内 .html 链接（外链 https:// 排除）。
  const deadLinks: Record<string, string[]> = {}
  const statuses: Record<string, number> = {}
  for (const page of site.pages) {
    const url = client.publicUrl(page.slug === 'index' ? '/' : `/${page.slug}`)
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
