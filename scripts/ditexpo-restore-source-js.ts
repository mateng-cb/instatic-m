/**
 * 修复 DITExpo 重导后源站行为 JS 未挂载：一页一包重导剥离了全部 `<script>`，
 * 此后只手工挂过 shared-classic（倒计时/汉堡/侧栏）与 module 版
 * news-swiper（`import 'swiper'`，importmap 指向未物化的 runtime cache，404）。
 * 表现：各页 carousel 轮播静态、proposal 招商方案 PDF 预览不加载。
 *
 * 本脚本按源站文件对照，全部走 **classic** 通道恢复（site.files +
 * runtime.scripts → `/_instatic/assets/` 同源可执行，CSP script-src 'self' 放行）：
 *
 *   共享（all-pages，priority 即执行顺序）：
 *     5  pointer 预置（swiper-bundle 之前，源站 head inline[0]）
 *     6  error-shield（含 GA gtag 打点，源站 head inline[1]）
 *     10 swiper-bundle.min.js        11 jquery-1.10.2.min.js
 *     20 shared-classic（10→20 调序到 vendor 之后）
 *     30 carousel（源站 19 页共享的手写轮播）
 *   专属（scope: pages）：
 *     indexv4.js → index + en-index（内部 `new Swiper` 用全局 Swiper）
 *     proposal：pdf.min.js + pdf.worker.min.js + 页面脚本
 *
 * pdf.worker 方案：classic 资产 URL 含每次发布都变的 versionId，workerSrc 不能
 * 硬编码 —— worker 文件头部注册 `document.currentScript.src` 到
 * `data-pdf-worker-src`，proposal 脚本（priority 更大、晚执行）读取并赋给
 * `pdfjsLib.GlobalWorkerOptions.workerSrc`，同页同版本自动对齐。
 *
 * 有意跳过（防双挂）：17 页 inline[3] 防御 stub 与 mobile-fixed-menu-v2.js
 * 都是汉堡菜单实现，shared-classic 已复刻且更完整（多 body overflow 处理），
 * 双挂会让两个 click listener 互相抵消（一个加 active 一个删）。index/en-index
 * 的 JSON-LD（inline[2]）非行为 JS，classic 挂会语法报错，引擎暂无该通道，不动。
 *
 * 同时删除 module 版 ditexpo-news-swiper.js（源站 news 页本无 swiper 初始化，
 * index/en-index 由 indexv4.js 接管）并清掉指向 404 的 packageImportmap。
 *
 *   INSTATIC_EMAIL=… INSTATIC_PASSWORD=… bun run scripts/ditexpo-restore-source-js.ts \
 *     [--api http://localhost:3001] [--src <源站目录>] [--pdf-url <URL>] [--apply]
 *
 * 默认 dry-run 只打印挂载计划；--apply 才写库并发布（saveSite + stepUp + publish）
 * 且逐页验证脚本顺序与资产可达性。--pdf-url 替换 proposal 的 PDF_URL 常量
 * （注意：发布页 CSP connect-src 回退 default-src 'self'，只有同源 /uploads/…
 * URL 可达，外部 https 会被挡）。源站 CDN 上的招商方案 PDF 已 404，等内容
 * 就绪后用本参数切换。
 */
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { SiteDocument } from '@core/page-tree'
import type { SiteScriptRuntimeConfig } from '../src/core/site-runtime'
import { CmsClient, takeEndpointArgs } from './lib/cmsClient'

const DEFAULT_SRC = 'D:/word_2022/word/25-0923-dite/DITExpohtml'
const REPORT = join(DEFAULT_SRC, 'doc/instatic-packs/source-js/验证报告-restore-source-js.json')

/** 源站 19 页 slug（signUp 文件名大小写映射，同 fix-home-links）。 */
const ALL_SLUGS = [
  'index', 'en-index', 'introduce', 'news', 'activity', 'conference', 'en-conference',
  'exhibitor-intro', 'exhibitor-list', 'download', 'live', 'map', 'floor-plan',
  'surroundings', 'transportation', 'pdf', 'en-exhibitor-intro', 'proposal', 'signup',
] as const
const SRC_NAME_OVERRIDES: Record<string, string> = { signup: 'signUp' }

// site.files 路径（upsert 按 path 幂等匹配）
const P_POINTER = 'src/scripts/ditexpo-pointer-pre.js'
const P_SHIELD = 'src/scripts/ditexpo-error-shield.js'
const P_SWIPER = 'src/scripts/vendor/swiper-bundle.min.js'
const P_JQUERY = 'src/scripts/vendor/jquery-1.10.2.min.js'
const P_CLASSIC = 'src/scripts/ditexpo-shared-classic.js' // 既有，仅调 priority
const P_CAROUSEL = 'src/scripts/ditexpo-carousel.js'
const P_INDEXV4 = 'src/scripts/ditexpo-indexv4.js'
const P_PDF = 'src/scripts/vendor/pdf.min.js'
const P_WORKER = 'src/scripts/vendor/pdf.worker.min.js'
const P_PROPOSAL = 'src/scripts/ditexpo-proposal.js'
const P_NEWS_SWIPER = 'src/scripts/ditexpo-news-swiper.js' // 删除

/** worker 文件头部的注册行：把自身资产 URL 暴露给同页后执行的 proposal 脚本。 */
const WORKER_REGISTER = `/* Instatic: 注册本文件 URL 供 pdfjs workerSrc 运行时读取（资产 URL 含每次发布变化的 versionId，不能硬编码）。本文件在主线程执行即 pdfjs v3 fake-worker 模式的标准行为，无副作用。 */
(function () {
  var d = document.currentScript;
  if (d && d.src) document.documentElement.setAttribute('data-pdf-worker-src', d.src);
})();
`

function classic(scope: SiteScriptRuntimeConfig['scope'], priority: number): SiteScriptRuntimeConfig {
  return {
    enabled: true,
    runInCanvas: false,
    format: 'classic',
    placement: 'body-end',
    timing: 'dom-ready',
    scope,
    priority,
  }
}

function upsertScriptFile(
  site: SiteDocument,
  path: string,
  content: string,
  config: SiteScriptRuntimeConfig,
): boolean {
  site.files ??= []
  site.runtime ??= { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {}, styles: {} }
  site.runtime.scripts ??= {}
  const existing = site.files.find((f) => f.path === path)
  const now = Date.now()
  if (existing) {
    const changed = existing.content !== content
    existing.content = content
    existing.updatedAt = now
    existing.type = 'script'
    site.runtime.scripts[existing.id] = config
    return changed
  }
  const id = nanoid()
  site.files.push({ id, path, type: 'script', content, createdAt: now, updatedAt: now })
  site.runtime.scripts[id] = config
  return true
}

function removeScriptFile(site: SiteDocument, path: string): boolean {
  site.files ??= []
  site.runtime ??= { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {}, styles: {} }
  site.runtime.scripts ??= {}
  const idx = site.files.findIndex((f) => f.path === path)
  if (idx < 0) return false
  delete site.runtime.scripts[site.files[idx]!.id]
  site.files.splice(idx, 1)
  return true
}

/** 文档序提取一页的全部 inline `<script>` 内容（去空段）。 */
async function inlineSegments(srcDir: string, slug: string): Promise<string[]> {
  const name = SRC_NAME_OVERRIDES[slug] ?? slug
  const html = await Bun.file(join(srcDir, `${name}.html`)).text()
  return [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]!.trim())
    .filter((s) => s.length > 0)
}

// ── inline 段指纹 ────────────────────────────────────────────────────────────
// 按内容判定（对段数/位置变化鲁棒），与 fix-home-links 的「文本对齐」同思路。
const isPointerSeg = (s: string) => s.includes('window.pointer = window.pointer')
const isShieldSeg = (s: string) => s.includes("addEventListener('error'") && s.includes('dataLayer')
const isCarouselSeg = (s: string) => s.startsWith('let currentSlide = 0')
const isJsonLdSeg = (s: string) => s.includes('"@context"')
/** 17 页的防御 stub：initMobileMenu 定义（与 shared-classic 同功能，跳过防双挂）。 */
const isMobileMenuStub = (s: string) => s.includes('function initMobileMenu')

// ── 验证 ─────────────────────────────────────────────────────────────────────
type PageVerify = {
  slug: string
  status: number
  /** classic 标签按出现顺序的文件名序列（去序号前缀）。 */
  order: string[]
  assetChecks: Record<string, string>
}

function classicOrder(html: string): string[] {
  return [...html.matchAll(/src="(\/_instatic\/assets\/[^" ]+\/classic\/[^" ]+)"/g)]
    .map((m) => m[1]!.split('/').pop()!)
    .map((name) => name.replace(/^\d+-/, ''))
}

function assertOrder(order: string[], expectedInOrder: string[]): void {
  let cursor = -1
  for (const name of expectedInOrder) {
    const at = order.indexOf(name)
    if (at === -1 || at < cursor) {
      throw new Error(`脚本顺序断言失败：期望 ${expectedInOrder.join(' < ')}，实际 ${order.join(' < ')}`)
    }
    cursor = at
  }
}

async function verifyPage(
  client: CmsClient,
  slug: string,
  assetCache: Map<string, string>,
): Promise<PageVerify> {
  const res = await fetch(client.publicUrl(slug === 'index' ? '/' : `/${slug}`))
  const html = await res.text()
  const order = classicOrder(html)

  assertOrder(order, ['ditexpo-pointer-pre.js', 'ditexpo-error-shield.js', 'swiper-bundle.min.js', 'jquery-1.10.2.min.js', 'ditexpo-shared-classic.js', 'ditexpo-carousel.js'])
  if (slug === 'index' || slug === 'en-index') {
    assertOrder(order, ['ditexpo-carousel.js', 'ditexpo-indexv4.js'])
  }
  if (slug === 'proposal') {
    assertOrder(order, ['ditexpo-carousel.js', 'pdf.min.js', 'pdf.worker.min.js', 'ditexpo-proposal.js'])
  }
  if (/type=["']module["'][^>]*news-swiper|news-swiper[^>]*type=["']module/i.test(html)) {
    throw new Error(`${slug}: module 版 news-swiper 残留`)
  }
  if (/<script[^>]*importmap/i.test(html)) {
    throw new Error(`${slug}: importmap 标签残留`)
  }

  // 资产可达性 + 内容特征（同 URL 只拉一次）
  const assetChecks: Record<string, string> = {}
  for (const m of html.matchAll(/src="(\/_instatic\/assets\/[^" ]+\/classic\/[^" ]+)"/g)) {
    const src = m[1]!
    if (assetCache.has(src)) continue
    const ares = await fetch(client.publicUrl(src))
    const body = ares.ok ? await ares.text() : ''
    assetCache.set(src, `${ares.status}`)
    assetChecks[src.split('/').pop()!] = `${ares.status} ${body.length}B`
    const name = src.split('/').pop()!
    const expects: Array<[RegExp, string]> = [
      [/swiper-bundle\.min\.js$/, /Swiper/],
      [/jquery-1\.10\.2\.min\.js$/, /jquery/i],
      [/ditexpo-indexv4\.js$/, /DITExpo Index Script/],
      [/pdf\.min\.js$/, /pdfjsLib|pdfjs/],
      [/pdf\.worker\.min\.js$/, /data-pdf-worker-src/],
      [/ditexpo-proposal\.js$/, /data-pdf-worker-src/],
      [/ditexpo-carousel\.js$/, /carousel-slide/],
      [/ditexpo-pointer-pre\.js$/, /window\.pointer/],
      [/ditexpo-error-shield\.js$/, /dataLayer/],
    ]
    for (const [re, contentRe] of expects) {
      if (re.test(name)) {
        if (ares.status !== 200) throw new Error(`${name}: 资产 ${res.status}`)
        if (!contentRe.test(body)) throw new Error(`${name}: 内容特征缺失（${contentRe}）`)
      }
    }
  }
  return { slug, status: res.status, order, assetChecks }
}

// ── main ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const argValue = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i !== -1 ? argv[i + 1] : undefined
}
const srcDir = argValue('--src') ?? DEFAULT_SRC
const pdfUrl = argValue('--pdf-url')
const rest = argv.filter((a, i) => a !== '--apply' && a !== '--src' && a !== '--pdf-url' && i !== argv.indexOf('--src') + 1 && i !== argv.indexOf('--pdf-url') + 1)
const { endpoint } = takeEndpointArgs(rest)

const client = new CmsClient(endpoint)
await client.login()
const { site, seq } = await client.loadSite()
const pageIdBySlug = new Map(site.pages.map((p) => [p.slug, p.id]))

// 读源站 vendor 文件
const readSrc = async (rel: string): Promise<string> => {
  const content = await Bun.file(join(srcDir, rel)).text()
  if (!content) throw new Error(`源文件为空：${rel}`)
  return content
}
const [swiperSrc, jquerySrc, indexv4Src, pdfSrc, workerSrc] = await Promise.all([
  readSrc('js/swiper-bundle.min.js'),
  readSrc('js/jquery-1.10.2.min.js'),
  readSrc('js/indexv4.js'),
  readSrc('js/pdfjs/pdf.min.js'),
  readSrc('js/pdfjs/pdf.worker.min.js'),
])

// inline 归类：共享段以任一页的出现为准（各页语义一致仅缩进不同），专属段按页收集
// （初始值须为 undefined：'' 是 falsy 但非 nullish，??= 不会写入）
let pointerSeg: string | undefined
let shieldSeg: string | undefined
let carouselSeg: string | undefined
const pageSpecific = new Map<string, string>()
const jsonLdPages: string[] = []
for (const slug of ALL_SLUGS) {
  for (const seg of await inlineSegments(srcDir, slug)) {
    if (isPointerSeg(seg)) pointerSeg ??= seg
    else if (isShieldSeg(seg)) shieldSeg ??= seg
    else if (isCarouselSeg(seg)) carouselSeg ??= seg
    else if (isJsonLdSeg(seg)) jsonLdPages.push(slug)
    else if (isMobileMenuStub(seg)) { /* 跳过：shared-classic 已复刻，双挂冲突 */ }
    else pageSpecific.set(slug, seg)
  }
}
if (!pointerSeg || !shieldSeg || !carouselSeg) {
  throw new Error('共享 inline 段提取不完整，中止')
}

// proposal 专属改写：workerSrc 读 dataset（运行时对齐当前发布的资产 URL）
let proposalSrc = pageSpecific.get('proposal')
if (!proposalSrc) {
  // proposal 的专属段自带一份 initMobileMenu（与 shared-classic 同功能），上面
  // 的 stub 指纹会把整段误杀——这里从原文重新提取并剥离汉堡部分，只留 PDF 逻辑。
  const segs = await inlineSegments(srcDir, 'proposal')
  proposalSrc = segs.find((s) => s.includes('initProposalPreview'))
  if (!proposalSrc) throw new Error('proposal 专属段缺失')
}
proposalSrc = proposalSrc
  .replace(/\n[ \t]*initMobileMenu\(\);/, '')
  .replace(/\nfunction initMobileMenu\(\) \{[\s\S]*?\n\}/, '')
if (proposalSrc.includes('initMobileMenu') || !proposalSrc.includes('initProposalPreview')) {
  throw new Error('proposal 汉堡剥离手术失败')
}
const workerLine = /pdfjsLib\.GlobalWorkerOptions\.workerSrc\s*=\s*'[^']*';?/
if (!workerLine.test(proposalSrc)) throw new Error('proposal 脚本中未找到 workerSrc 赋值行')
proposalSrc = proposalSrc.replace(
  workerLine,
  "pdfjsLib.GlobalWorkerOptions.workerSrc = document.documentElement.getAttribute('data-pdf-worker-src') || './js/pdfjs/pdf.worker.min.js';",
)
if (pdfUrl) {
  if (!/PDF_URL\s*=\s*'[^']*'/.test(proposalSrc)) throw new Error('proposal 脚本中未找到 PDF_URL 常量')
  proposalSrc = proposalSrc.replace(/PDF_URL\s*=\s*'[^']*'/, `PDF_URL = '${pdfUrl}'`)
}
pageSpecific.set('proposal', proposalSrc)

// 专属段 → site.files 路径。indexv4 走 vendor 外链形式；conference/en-conference
// 的末段 = 汉堡 + 被源站注释掉调用的 initConferenceList（定义活、调用死，源站
// 从未启用议程展开），落进 stub 跳过分支即保真；其余页无专属段。
const SPECIFIC_PATHS: Record<string, string> = {
  proposal: P_PROPOSAL,
}

const plan: string[] = []
const ids = (slugs: string[]) => slugs.map((s) => pageIdBySlug.get(s)).filter((x): x is string => Boolean(x))

const mounts: Array<{ path: string; content: string; config: SiteScriptRuntimeConfig; note: string }> = [
  { path: P_POINTER, content: pointerSeg, config: classic({ type: 'all-pages' }, 5), note: 'pointer 预置（swiper 前）' },
  { path: P_SHIELD, content: shieldSeg, config: classic({ type: 'all-pages' }, 6), note: '错误屏蔽 + GA gtag' },
  { path: P_SWIPER, content: swiperSrc, config: classic({ type: 'all-pages' }, 10), note: `${swiperSrc.length}B` },
  { path: P_JQUERY, content: jquerySrc, config: classic({ type: 'all-pages' }, 11), note: `${jquerySrc.length}B` },
  { path: P_CAROUSEL, content: carouselSeg, config: classic({ type: 'all-pages' }, 30), note: '手写轮播' },
  { path: P_INDEXV4, content: indexv4Src, config: classic({ type: 'pages', pageIds: ids(['index', 'en-index']) }, 50), note: 'index/en-index（new Swiper 全局版）' },
  { path: P_PDF, content: pdfSrc, config: classic({ type: 'pages', pageIds: ids(['proposal']) }, 50), note: `${pdfSrc.length}B` },
  { path: P_WORKER, content: WORKER_REGISTER + workerSrc, config: classic({ type: 'pages', pageIds: ids(['proposal']) }, 51), note: `注册行 + ${workerSrc.length}B` },
]
for (const slug of Object.keys(SPECIFIC_PATHS)) {
  const seg = pageSpecific.get(slug)
  if (!seg) continue
  mounts.push({
    path: SPECIFIC_PATHS[slug]!,
    content: seg,
    config: classic({ type: 'pages', pageIds: ids([slug]) }, slug === 'proposal' ? 60 : 50),
    note: `${slug} 专属 ${seg.length}B`,
  })
}

for (const m of mounts) {
  plan.push(`+ ${m.path.padEnd(44)} p${String(m.config.priority).padStart(2)}  ${m.note}`)
}
plan.push(`~ ${P_CLASSIC}  priority 10 → 20（调到 vendor 之后）`)
plan.push(`- ${P_NEWS_SWIPER}  （module 版删除：import 'swiper' 走 404 的 runtime cache）`)
plan.push('- runtime.packageImportmap  （指向 404 cache，清掉）')
if (jsonLdPages.length) plan.push(`? 跳过 JSON-LD：${jsonLdPages.join(', ')}（非行为 JS，引擎无该通道）`)
plan.push('? 跳过 17 页汉堡 stub + mobile-fixed-menu-v2.js（shared-classic 已复刻，双挂冲突）')
console.log(plan.join('\n'))

if (!APPLY) {
  console.log('\ndry-run 结束（未写入）。加 --apply 执行写入+发布+验证。')
  process.exit(0)
}

for (const m of mounts) upsertScriptFile(site, m.path, m.content, m.config)
{
  const shared = site.files.find((f) => f.path === P_CLASSIC)
  if (shared) {
    const cfg = site.runtime.scripts[shared.id]
    if (cfg) cfg.priority = 20
  }
}
removeScriptFile(site, P_NEWS_SWIPER)
if (site.runtime) {
  // 发布时 importmap 从 dependencyLock 重建（publishSite.ts:118），只删
  // packageImportmap 字段没用——依赖已无引用者，连 lock 一起清空才能让
  // importmap 标签与 404 的 runtime cache 引用彻底消失。
  delete site.runtime.packageImportmap
  site.runtime.dependencyLock = { version: 1, packages: {}, updatedAt: Date.now() }
}

await client.saveSite(site, seq)
await client.stepUp()
await client.publish()
console.log('已写入并发布，开始验证…')

const assetCache = new Map<string, string>()
const pages: PageVerify[] = []
const failures: Array<{ slug: string; error: string }> = []
for (const page of site.pages) {
  try {
    pages.push(await verifyPage(client, page.slug, assetCache))
  } catch (err) {
    failures.push({ slug: page.slug, error: err instanceof Error ? err.message : String(err) })
  }
}
const report = {
  ok: failures.length === 0 && pages.every((p) => p.status === 200),
  verifiedPages: pages.map(({ slug, status, order }) => ({ slug, status, order })),
  failures,
  assets: Object.fromEntries(assetCache.entries()),
  pdfUrl: pdfUrl ?? '(保留源站 CDN 原值——该 PDF 已 404，内容待用户提供后用 --pdf-url 切换)',
  jsonLdSkipped: jsonLdPages,
  at: new Date().toISOString(),
}
await Bun.write(REPORT, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ ...report, verifiedPages: `${pages.length}/${site.pages.length} 页断言通过` }, null, 2))
console.log(`\n报告：${REPORT}`)
if (!report.ok) process.exit(2)
