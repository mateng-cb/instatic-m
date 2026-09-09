/**
 * 通过 CMS API 做无头可行性导入（不走 Playwright）。
 *
 *   bun run scripts/verify-ditexpo-api-import.ts
 *
 * 流程：登录 → 加载站点 → buildImportPlan → 上传资源 → 变更站点 →
 * PUT site-document（replace）→ step-up → 发布 → GET /
 */
import { GlobalWindow } from 'happy-dom'
import { readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { nanoid } from 'nanoid'
import '@modules/base'
import {
  buildImportPlan,
  commitImportPlan,
  applyConflictResolutions,
  detectConflicts,
  type FileMap,
  type ImportPlan,
  type SiteImportAdapter,
  type SiteImportTransaction,
  type NewStyleRule,
} from '@core/siteImport'
import type { ImportFragment } from '@core/htmlImport'
import {
  addPage,
  createNode,
  reindexNodeParents,
  type PageNode,
  type SiteDocument,
  type StyleRule,
} from '@core/page-tree'
import { pageFromRow } from '../src/core/data/pageFromRow'
import { visualComponentFromRow } from '../src/core/data/componentFromRow'
import { savedLayoutFromRow } from '../src/core/data/layoutFromRow'
import {
  createStyleRuleOrderAllocator,
  findReimportedStyleRule,
  indexStyleRulesByName,
  indexStyleRulesByOrigin,
  linkImportedClassNames,
  registerStyleRuleOrigin,
} from '../src/admin/pages/site/store/slices/site/importLinking'

const API = 'http://localhost:3001/admin/api/cms'
const EMAIL = 'admin@ditexpo.local'
const PASSWORD = 'DitexpoVerify1!'

function parseArgs(argv: string[]) {
  let pack = join(import.meta.dir, '../../DITExpohtml/doc/instatic-import-pack')
  let slug = 'index'
  let clearAllStyleRules = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--pack') pack = argv[++i] ?? pack
    else if (a === '--slug') slug = argv[++i] ?? slug
    else if (a === '--clear-all-style-rules') clearAllStyleRules = true
  }
  pack = isAbsolute(pack) ? resolve(pack) : resolve(process.cwd(), pack)
  const report = join(pack, `验证报告-api-import-${slug}.json`)
  return { pack, slug, clearAllStyleRules, report }
}

/** 打包入口固定为 index.html；当 --slug 不同时重映射目标 slug。 */
function applyTargetSlug(plan: ImportPlan, targetSlug: string, site: SiteDocument): ImportPlan {
  const pages = plan.pages.map((p) => {
    const base = basename(p.source, '.html')
    if (base === 'index') return { ...p, slug: targetSlug }
    return p
  })
  if (pages.every((p, i) => p.slug === plan.pages[i]!.slug)) return plan
  const detected = detectConflicts(site, pages, plan.styleRules, plan.colors, plan.fontTokens)
  return {
    ...plan,
    pages,
    conflicts: {
      ...plan.conflicts,
      pages: detected.pages,
      rules: detected.rules,
      tokens: detected.tokens,
    },
  }
}

const happyWindow = new GlobalWindow({
  url: 'http://localhost/',
  settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true },
})
// 媒体上传继续用 Bun 原生 File/Blob/FormData；只 polyfill DOMParser。
Object.assign(globalThis, {
  window: happyWindow,
  document: happyWindow.document,
  DOMParser: happyWindow.DOMParser,
  Node: happyWindow.Node,
  HTMLElement: happyWindow.HTMLElement,
  Element: happyWindow.Element,
  Document: happyWindow.Document,
  DocumentFragment: happyWindow.DocumentFragment,
})

class CookieJar {
  private cookies = new Map<string, string>()
  absorb(res: Response) {
    const raw = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : []
    const list = raw.length ? raw : [res.headers.get('set-cookie')].filter(Boolean) as string[]
    for (const line of list) {
      const part = line.split(';')[0]!
      const eq = part.indexOf('=')
      if (eq > 0) this.cookies.set(part.slice(0, eq), part.slice(eq + 1))
    }
  }
  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

async function api(
  jar: CookieJar,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  const cookie = jar.header()
  if (cookie) headers.set('cookie', cookie)
  const res = await fetch(`${API}${path}`, { ...init, headers })
  jar.absorb(res)
  return res
}

function guessMime(path: string): string | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.html')) return 'text/html'
  if (lower.endsWith('.css')) return 'text/css'
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'application/javascript'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.ico')) return 'image/x-icon'
  return undefined
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      out.push(...(await walkFiles(full)))
      continue
    }
    if (entry.name.startsWith('.')) continue
    if (/\.(md|ts|json|zip)$/i.test(entry.name)) continue
    out.push(full)
  }
  return out
}

function applyImportedBodyAttributes(
  rootNode: PageNode,
  fragment: ImportFragment,
  site: SiteDocument,
  byName: Map<string, string>,
  allocateOrder: () => number,
) {
  const body = fragment.body
  if (!body) return
  if (body.props && Object.keys(body.props).length > 0) {
    rootNode.props = { ...rootNode.props, ...body.props }
  }
  if (body.classIds?.length) {
    rootNode.classIds = linkImportedClassNames(body.classIds, site.styleRules, byName, allocateOrder)
  }
  if (body.inlineStyles && Object.keys(body.inlineStyles).length > 0) {
    rootNode.inlineStyles = body.inlineStyles
  }
}

function makeInMemoryAdapter(site: SiteDocument, jar: CookieJar, stats: { uploads: number }) {
  const adapter: SiteImportAdapter = {
    async installGoogleFont(font) {
      // 可行性验证跳过联网安装字体，返回占位条目。
      return {
        id: nanoid(),
        source: 'google',
        family: font.family,
        variants: font.variants,
        subsets: font.subsets,
        files: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
    },
    async uploadAsset({ path, bytes, mimeType }) {
      const form = new FormData()
      const file = new File([bytes.slice().buffer as ArrayBuffer], basename(path), {
        type: mimeType || 'application/octet-stream',
      })
      form.set('file', file)
      const res = await api(jar, '/media', { method: 'POST', body: form })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`upload ${path} failed: ${res.status} ${text}`)
      }
      const json = (await res.json()) as { asset?: { publicPath?: string; url?: string } }
      const url = json.asset?.publicPath ?? json.asset?.url
      if (!url) throw new Error(`upload ${path}: missing publicPath`)
      stats.uploads++
      if (stats.uploads % 25 === 0) console.log(`[upload] ${stats.uploads} assets…`)
      return { url, warnings: [] }
    },
    async commit(recipe) {
      const byName = indexStyleRulesByName(site.styleRules)
      const byOrigin = indexStyleRulesByOrigin(site.styleRules)
      const allocateOrder = createStyleRuleOrderAllocator(site.styleRules)
      const tx: SiteImportTransaction = {
        addPage({ id: pageId, title, slug, nodeFragment }) {
          const page = addPage(site, title, slug)
          if (pageId) page.id = pageId
          applyImportedBodyAttributes(page.nodes[page.rootNodeId]!, nodeFragment, site, byName, allocateOrder)
          for (const [id, node] of Object.entries(nodeFragment.nodes)) {
            page.nodes[id] = {
              ...node,
              classIds: linkImportedClassNames(node.classIds, site.styleRules, byName, allocateOrder),
            }
          }
          page.nodes[page.rootNodeId]!.children = [...nodeFragment.rootIds]
          reindexNodeParents(page.nodes)
          return page.id
        },
        putStyleRule(rule: NewStyleRule) {
          // 与 store helpers.putStyleRule 同语义：同 origin+selector 的重导入规则
          // 原位替换（id 与 order 保留），避免重复堆叠（#404）。
          const reimported = findReimportedStyleRule(byOrigin, rule)
          if (reimported) {
            tx.overwriteStyleRule(reimported.id, rule)
            return reimported.id
          }
          const id = nanoid()
          const now = Date.now()
          const newRule: StyleRule = { ...rule, id, createdAt: now, updatedAt: now, order: allocateOrder() }
          site.styleRules[id] = newRule
          registerStyleRuleOrigin(byOrigin, newRule)
          if (rule.kind === 'class') byName.set(rule.name, id)
          return id
        },
        overwritePage(pageId, { title, slug, nodeFragment }) {
          const page = site.pages.find((p) => p.id === pageId)
          if (!page) throw new Error(`overwritePage missing ${pageId}`)
          const rootNode = createNode('base.body')
          rootNode.children = [...nodeFragment.rootIds]
          applyImportedBodyAttributes(rootNode, nodeFragment, site, byName, allocateOrder)
          const newNodes: Record<string, PageNode> = { [rootNode.id]: rootNode }
          for (const [id, node] of Object.entries(nodeFragment.nodes)) {
            newNodes[id] = {
              ...node,
              classIds: linkImportedClassNames(node.classIds, site.styleRules, byName, allocateOrder),
            }
          }
          reindexNodeParents(newNodes)
          page.rootNodeId = rootNode.id
          page.nodes = newNodes
          page.title = title
          page.slug = slug
        },
        overwriteStyleRule(ruleId, rule) {
          const existing = site.styleRules[ruleId]
          if (!existing) throw new Error(`overwriteStyleRule missing ${ruleId}`)
          site.styleRules[ruleId] = {
            ...rule,
            id: ruleId,
            createdAt: existing.createdAt,
            updatedAt: Date.now(),
            order: existing.order,
          }
          if (rule.kind === 'class') byName.set(rule.name, ruleId)
        },
        addConditions(conditions) {
          if (!site.conditions) site.conditions = []
          const existing = new Set(site.conditions.map((c) => c.id))
          for (const def of conditions) {
            if (!existing.has(def.id)) site.conditions.push(def)
          }
        },
        addFonts() { return [] },
        addInstalledFonts(fonts) {
          if (!site.settings.fonts) site.settings.fonts = []
          const out: { id: string; family: string }[] = []
          for (const font of fonts) {
            if (!site.settings.fonts.some((f) => f.id === font.id)) {
              site.settings.fonts.push(font)
              out.push({ id: font.id, family: font.family })
            }
          }
          return out
        },
        addFontTokens() { return [] },
        overwriteFontTokens() { return [] },
        addColorTokens() { return [] },
        overwriteColorTokens() { return [] },
        addScripts() { return [] },
        addStylesheets() { return [] },
      }
      recipe(tx)
    },
  }
  return adapter
}

async function main() {
  const { pack: PACK, slug: TARGET_SLUG, clearAllStyleRules, report: REPORT } = parseArgs(process.argv.slice(2))
  const jar = new CookieJar()
  const steps: string[] = []
  const t0 = performance.now()
  steps.push(`args pack=${PACK} slug=${TARGET_SLUG} clearAllStyleRules=${clearAllStyleRules}`)

  // 1) 登录
  {
    const res = await api(jar, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
    if (!res.ok) throw new Error(`login failed ${res.status} ${await res.text()}`)
    steps.push('login-ok')
  }

  // 2) 加载站点
  const [shellRes, pagesRes, componentsRes, layoutsRes] = await Promise.all([
    api(jar, '/site'),
    api(jar, '/pages'),
    api(jar, '/components'),
    api(jar, '/layouts'),
  ])
  if (!shellRes.ok || !pagesRes.ok) {
    throw new Error(`load site failed shell=${shellRes.status} pages=${pagesRes.status}`)
  }
  const shellBody = await shellRes.json() as { site: Omit<SiteDocument, 'pages' | 'visualComponents' | 'layouts'>; seq: number }
  const pagesBody = await pagesRes.json() as { rows: unknown[] }
  const componentsBody = componentsRes.ok ? await componentsRes.json() as { rows: unknown[] } : { rows: [] }
  const layoutsBody = layoutsRes.ok ? await layoutsRes.json() as { rows: unknown[] } : { rows: [] }

  const pages = pagesBody.rows.map((row) => pageFromRow(row as never)).filter(Boolean)
  const visualComponents = componentsBody.rows
    .map((row) => visualComponentFromRow(row as never))
    .filter(Boolean)
  const layouts = layoutsBody.rows
    .map((row) => savedLayoutFromRow(row as never))
    .filter(Boolean)

  const site: SiteDocument = {
    ...(shellBody.site as SiteDocument),
    pages: pages as SiteDocument['pages'],
    visualComponents: visualComponents as SiteDocument['visualComponents'],
    layouts: layouts as SiteDocument['layouts'],
  }
  if (clearAllStyleRules) {
    site.styleRules = {}
    steps.push(`site-loaded pages=${site.pages.length} styleRules-cleared-all`)
  } else {
    steps.push(`site-loaded pages=${site.pages.length} styleRules-kept (conflict overwrite only)`)
  }

  // 3) 构建 FileMap + ImportPlan
  const files = await walkFiles(PACK)
  const fileMap: FileMap = { files: {} }
  for (const abs of files) {
    const key = relative(PACK, abs).split(sep).join('/')
    fileMap.files[key] = {
      bytes: new Uint8Array(await Bun.file(abs).arrayBuffer()),
      mimeType: guessMime(key),
    }
  }
  let plan = buildImportPlan({ fileMap, currentSite: site })
  plan = applyTargetSlug(plan, TARGET_SLUG, site)
  // 强制全部 overwrite。commitImportPlan 会读 plan.conflicts.*
  //（不只看 applyConflictResolutions 对页面 slug 的改写），
  // 因此必须直接改写 plan 上的 conflicts。
  const pageResolutions = plan.conflicts.pages.map((c) => ({
    ...c,
    defaultResolution: { action: 'overwrite' as const, resolvedSlug: c.desiredSlug },
  }))
  const ruleResolutions = plan.conflicts.rules.map((c) => ({
    ...c,
    defaultResolution: { action: 'overwrite' as const, resolvedName: c.desiredName },
  }))
  const tokenResolutions = plan.conflicts.tokens.map((c) => ({
    ...c,
    defaultResolution: { action: 'overwrite' as const, resolvedVariable: c.desiredVariable },
  }))
  const crossSheetResolutions = (plan.conflicts.crossSheetClasses ?? []).map((c) => ({
    ...c,
    defaultResolution: { action: 'overwrite' as const, resolvedName: c.desiredName },
  }))
  plan = applyConflictResolutions(
    plan,
    pageResolutions,
    ruleResolutions,
    tokenResolutions,
    crossSheetResolutions,
  )
  plan = {
    ...plan,
    conflicts: {
      ...plan.conflicts,
      pages: pageResolutions,
      rules: ruleResolutions,
      tokens: tokenResolutions,
      crossSheetClasses: crossSheetResolutions,
    },
  }
  steps.push(`plan pages=${plan.pages.length} rules=${plan.styleRules.length} assets=${plan.assets.length} pageConflicts=${pageResolutions.length}`)

  // 4) 提交（上传资源 + 变更内存站点）
  const stats = { uploads: 0 }
  const adapter = makeInMemoryAdapter(site, jar, stats)
  const result = await commitImportPlan(plan, adapter)
  steps.push(`committed uploads=${stats.uploads} resultPages=${result.pages.length}`)

  // 5) replace 模式保存站点文档
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
  if (!saveRes.ok) {
    throw new Error(`site-document save failed ${saveRes.status} ${await saveRes.text()}`)
  }
  steps.push('site-document-saved')

  // 6) step-up 提权 + 发布
  const stepUp = await api(jar, '/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  if (!stepUp.ok) throw new Error(`step-up failed ${stepUp.status} ${await stepUp.text()}`)
  steps.push('step-up-ok')

  const pubRes = await api(jar, '/publish', { method: 'POST' })
  if (!pubRes.ok) throw new Error(`publish failed ${pubRes.status} ${await pubRes.text()}`)
  const pubJson = await pubRes.json()
  steps.push(`publish-ok ${JSON.stringify(pubJson)}`)

  // 7) 公开页校验
  const home = await fetch('http://localhost:3001/')
  const homeHtml = await home.text()
  const homeOk = home.status === 200 && /DITExpo|数字基础设施/i.test(homeHtml)

  let pageOk = true
  let pageStatus = 0
  let pageHtml = ''
  let pageHasContent = true
  if (TARGET_SLUG !== 'index') {
    const pageRes = await fetch(`http://localhost:3001/${TARGET_SLUG}`)
    pageStatus = pageRes.status
    pageHtml = await pageRes.text()
    pageHasContent = /展会介绍|DITExpo|数字基础设施/i.test(pageHtml)
    pageOk = pageStatus === 200 && pageHasContent
    steps.push(`verify /${TARGET_SLUG} status=${pageStatus} content=${pageHasContent}`)
  }

  const importedPage = savedPages.find((p) => p.slug === TARGET_SLUG)
  const report = {
    ok: homeOk && pageOk,
    slug: TARGET_SLUG,
    pack: PACK,
    home: { status: home.status, ok: homeOk, htmlLength: homeHtml.length },
    page: TARGET_SLUG === 'index'
      ? undefined
      : { status: pageStatus, ok: pageOk, hasContent: pageHasContent, htmlLength: pageHtml.length },
    nodeCount: Object.keys(importedPage?.nodes ?? {}).length,
    styleRuleCount: Object.keys(site.styleRules).length,
    uploads: stats.uploads,
    durationMs: Math.round(performance.now() - t0),
    steps,
    snippet: (TARGET_SLUG === 'index' ? homeHtml : pageHtml || homeHtml).slice(0, 1000),
    at: new Date().toISOString(),
  }
  await Bun.write(REPORT, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exit(2)
}

main().catch(async (err) => {
  const { report: REPORT } = parseArgs(process.argv.slice(2))
  const report = {
    ok: false,
    error: err instanceof Error ? err.stack ?? err.message : String(err),
    at: new Date().toISOString(),
  }
  await Bun.write(REPORT, JSON.stringify(report, null, 2))
  console.error(JSON.stringify(report, null, 2))
  process.exit(1)
})
