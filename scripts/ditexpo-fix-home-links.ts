/**
 * 修复导入工具链的「回首页链接自指」缺陷：一页一包打包把 entry 页改名为
 * index.html，导入器于是把源站 HTML 里指向 `index.html` / `en-index.html`
 * （含 `#anchor` 变体）的链接解析成「包内主页 = 当前页」，存为
 * `cms:page:<当前页id>`。发布后二级页 header logo、导航锚点、页脚联系我们
 * 全部变成指向当前页自身（首页 index 的同类链接恰好语义正确，不受影响）。
 *
 * 修复按源站 HTML 对照恢复：读源文件中 `index.html(#x)?` / `en-index.html(#x)?`
 * 链接（文档序，带可见文本；HTML 注释内的链接剔除——源站有 7 页把「展馆平面图」
 * nav 项注释掉，导入器正确地不导入，提取端必须同样忽略），与页面树中「自引的
 * cms:page: 链接」按文本对齐消耗：
 *   裸链接  → cms:page:<对应首页页id>（中文页→index，英文页→en-index）
 *   锚点型  → cms:page:<首页页id>#<anchor>（官方 pageRef 格式）
 *
 * 文本对齐（而非按序/按数量）的原因：个别页的部分链接已健康（如 exhibitor-list
 * 的 logo 已指向 index 页），数量配对会把整页判成 MISMATCH；文本匹配只消耗真正
 * 对得上的自引，剩余源站链接在树里找到同文本节点即视为已健康跳过。
 *
 *   INSTATIC_EMAIL=… INSTATIC_PASSWORD=… bun run scripts/ditexpo-fix-home-links.ts \
 *     [--api http://localhost:3001] [--src <源站目录>] [--apply]
 *
 * 默认 dry-run 只打印配对表；--apply 才写库并发布（saveSite + stepUp + publish）。
 * 端点凭据见 scripts/lib/cmsClient.ts。自引找不到同文本源站链接、或剩余源站链接
 * 在树里无同文本节点（导入丢节点）的页面整页跳过并标记 MISMATCH。
 */
import { join } from 'node:path'
import type { PageNode, SiteDocument } from '@core/page-tree'
import { CmsClient, takeEndpointArgs } from './lib/cmsClient'

const DEFAULT_SRC = 'D:/word_2022/word/25-0923-dite/DITExpohtml'
/** 树 slug → 源站文件名（仅大小写不同的映射）。 */
const SRC_NAME_OVERRIDES: Record<string, string> = { signup: 'signUp' }

type SourceHomeLink = {
  raw: string
  anchor: string | null
  homeSlug: 'index' | 'en-index'
  /** `<a>` 标签内到下一个 `<` 的可见文本，trim 后空串 = logo（img-only）。 */
  text: string
}

/** 文档序提取源站 HTML 中指向两种首页的链接（含锚点变体与可见文本）。 */
function extractHomeLinks(html: string): SourceHomeLink[] {
  const out: SourceHomeLink[] = []
  const visible = html.replace(/<!--[\s\S]*?-->/g, '')
  const re = /href="(en-index|index)\.html(#[\w-]+)?"[^>]*>([^<]*)/g
  for (const m of visible.matchAll(re)) {
    out.push({
      raw: `${m[1]}.html${m[2] ?? ''}`,
      anchor: m[2]?.slice(1) ?? null,
      homeSlug: m[1] === 'en-index' ? 'en-index' : 'index',
      text: (m[3] ?? '').trim(),
    })
  }
  return out
}

/** 文档序收集页面树中自引的 cms:page: 链接节点。 */
function collectSelfRefs(page: SiteDocument['pages'][number]): PageNode[] {
  const out: PageNode[] = []
  const selfRef = `cms:page:${page.id}`
  const walk = (id: string): void => {
    const node = page.nodes[id]
    if (!node) return
    if (node.moduleId === 'base.link' && node.props?.href === selfRef) out.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(page.rootNodeId)
  return out
}

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const srcIdx = argv.indexOf('--src')
const srcDir = srcIdx !== -1 ? argv[srcIdx + 1]! : DEFAULT_SRC
const rest = argv.filter((a, i) => a !== '--apply' && a !== '--src' && i !== srcIdx + 1)
const { endpoint } = takeEndpointArgs(rest)

const client = new CmsClient(endpoint)
await client.login()
const { site, seq } = await client.loadSite()

const pageBySlug = new Map(site.pages.map((p) => [p.slug, p]))
let fixed = 0
const skipped: string[] = []
const healthy: string[] = []
const plan: string[] = []

for (const page of site.pages) {
  if (page.slug === 'index') continue // logo 自指语义正确，跳过
  const srcName = SRC_NAME_OVERRIDES[page.slug] ?? page.slug
  const html = await Bun.file(join(srcDir, `${srcName}.html`)).text().catch(() => null)
  if (html === null) {
    skipped.push(`${page.slug}: 源文件缺失 ${srcName}.html`)
    continue
  }

  const pool = extractHomeLinks(html)
  const selfRefs = collectSelfRefs(page)

  // 树里全部 link 的文本集合，用于核对剩余源站链接是否已有健康节点。
  const treeLinkTexts = new Set<string>()
  for (const node of Object.values(page.nodes)) {
    if (node.moduleId === 'base.link') treeLinkTexts.add(String(node.props?.text ?? '').trim())
  }

  // 按文本对齐消耗：每个自引取第一个未消耗的同文本源站链接。
  const consumed = new Set<number>()
  const matched: { node: PageNode; link: SourceHomeLink }[] = []
  const unmatched: string[] = []
  for (const node of selfRefs) {
    const text = String(node.props?.text ?? '').trim()
    const idx = pool.findIndex((l, i) => !consumed.has(i) && l.text === text)
    if (idx === -1) {
      unmatched.push(text || '(logo)')
      continue
    }
    consumed.add(idx)
    matched.push({ node, link: pool[idx]! })
  }

  const leftover = pool.filter((_, i) => !consumed.has(i))
  const missingInTree = leftover.filter((l) => !treeLinkTexts.has(l.text))
  if (unmatched.length > 0 || missingInTree.length > 0) {
    skipped.push(
      `${page.slug}: MISMATCH 自引无源=${JSON.stringify(unmatched)} 树缺节点=${JSON.stringify(missingInTree.map((l) => l.text))}`,
    )
    continue
  }

  for (const { node, link } of matched) {
    const homePageId = pageBySlug.get(link.homeSlug)?.id
    const fragment = link.anchor !== null ? `#${link.anchor}` : ''
    // 官方 pageRef 格式（cms:page:<id>#fragment），slug 改名后链接依然有效；
    // 首页页缺失时退回裸路径（理论上不会发生）。
    const next =
      homePageId !== null
        ? `cms:page:${homePageId}${fragment}`
        : `${link.homeSlug === 'index' ? '/' : `/${link.homeSlug}`}${fragment}`
    const props = node.props as Record<string, unknown>
    plan.push(`${page.slug} ${JSON.stringify(String(props.text ?? '').slice(0, 10))}: ${String(props.href)} -> ${next}  (源 ${link.raw})`)
    props.href = next
    fixed++
  }
  if (leftover.length > 0) {
    healthy.push(`${page.slug}: ${leftover.length} 条源站链接已是健康节点（${leftover.map((l) => l.text || '(logo)').join('、')}）`)
  }
}

console.log(plan.join('\n'))
console.log(`\n修复 ${fixed} 条自引链接；跳过 ${skipped.length} 页${skipped.length ? '：\n  ' + skipped.join('\n  ') : ''}${healthy.length ? `\n健康跳过：\n  ${healthy.join('\n  ')}` : ''}`)

if (!APPLY) {
  console.log('dry-run 结束（未写入）。加 --apply 执行写入+发布。')
  process.exit(0)
}

await client.saveSite(site, seq)
await client.stepUp()
await client.publish()
console.log('已写入并发布。')
