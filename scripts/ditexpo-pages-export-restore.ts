/**
 * 导出 / 回写 DITExpo 站点的页面树（不含样式体系）。
 *
 * 生产快照修复工作流的核心保险：页面树节点只携带类名字符串（classIds），
 * 不携带样式定义，因此「导出手工改过的页面树 → 全量重导 18 页（重建干净
 * 的样式注册表）→ 回写页面树」可以在保住人工内容的同时拿到新样式体系。
 *
 *   # 导出（重导前跑一次，全部页面都备下来）
 *   INSTATIC_EMAIL=… INSTATIC_PASSWORD=… bun run scripts/ditexpo-pages-export-restore.ts \
 *     --export [--out <目录>]
 *
 *   # 回写（重导 + 三个修复脚本全部跑完之后，把手工改动页的树写回去）
 *   INSTATIC_EMAIL=… INSTATIC_PASSWORD=… bun run scripts/ditexpo-pages-export-restore.ts \
 *     --restore --slugs index,news [--from <目录>]
 *
 * 默认目录 .scratch/ditexpo-offline-repair/pages-backup/。回写按 slug 匹配、
 * 保留当前页 id，保存、提权、发布后逐页验证 200 + 节点数与回写快照一致。
 * 端点与凭据见 scripts/lib/cmsClient.ts（--api/--email/--password 或
 * INSTATIC_API/INSTATIC_EMAIL/INSTATIC_PASSWORD 环境变量）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@core/page-tree'
import { CmsClient, takeEndpointArgs } from './lib/cmsClient'

const DEFAULT_DIR = join(import.meta.dir, '../.scratch/ditexpo-offline-repair/pages-backup')

type PagesBackup = {
  exportedAt: string
  origin: string
  pages: Page[]
}

function parseRunArgs(argv: string[]) {
  let mode: 'export' | 'restore' | null = null
  let dir = DEFAULT_DIR
  let slugs: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--export') mode = 'export'
    else if (a === '--restore') mode = 'restore'
    else if (a === '--out' || a === '--from') dir = argv[++i] ?? dir
    else if (a === '--slugs') {
      slugs = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    } else {
      throw new Error(`未知参数 ${a}`)
    }
  }
  if (!mode) {
    throw new Error('用法：--export [--out <目录>]，或 --restore --slugs <slug列表> [--from <目录>]')
  }
  if (mode === 'restore' && slugs.length === 0) {
    throw new Error('--restore 需要 --slugs <slug列表>（逗号分隔），明确要回写哪些页')
  }
  return { mode, dir, slugs }
}

function isPageLike(value: unknown): value is Page {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string'
    && typeof v.slug === 'string'
    && typeof v.rootNodeId === 'string'
    && typeof v.nodes === 'object' && v.nodes !== null
  )
}

function parseBackup(raw: unknown): PagesBackup {
  if (typeof raw !== 'object' || raw === null) throw new Error('备份根不是对象')
  const v = raw as Record<string, unknown>
  if (!Array.isArray(v.pages) || !v.pages.every(isPageLike)) {
    throw new Error('备份缺合法的 pages 数组（每项需 id/slug/rootNodeId/nodes）')
  }
  return {
    exportedAt: typeof v.exportedAt === 'string' ? v.exportedAt : '',
    origin: typeof v.origin === 'string' ? v.origin : '',
    pages: v.pages,
  }
}

async function runExport(client: CmsClient, dir: string) {
  const steps: string[] = []
  const t0 = performance.now()

  await client.login()
  steps.push('login-ok')
  const { site } = await client.loadSite()

  const backup: PagesBackup = {
    exportedAt: new Date().toISOString(),
    origin: client.origin,
    pages: site.pages,
  }
  const outFile = join(dir, 'pages.json')
  await Bun.write(outFile, JSON.stringify(backup, null, 2))
  steps.push(`exported pages=${site.pages.length} → ${outFile}`)

  return {
    ok: site.pages.length > 0,
    mode: 'export' as const,
    pages: site.pages.map((p) => ({
      slug: p.slug,
      id: p.id,
      nodeCount: Object.keys(p.nodes).length,
    })),
    outFile,
    durationMs: Math.round(performance.now() - t0),
    steps,
    at: new Date().toISOString(),
  }
}

async function runRestore(client: CmsClient, dir: string, slugs: string[]) {
  const steps: string[] = []
  const t0 = performance.now()

  const backupFile = join(dir, 'pages.json')
  if (!existsSync(backupFile)) throw new Error(`找不到备份文件 ${backupFile}`)
  const backup = parseBackup(JSON.parse(await Bun.file(backupFile).text()))
  steps.push(`backup-loaded pages=${backup.pages.length} exportedAt=${backup.exportedAt || '?'}`)

  await client.login()
  steps.push('login-ok')
  const { site, seq } = await client.loadSite()

  const backupBySlug = new Map(backup.pages.map((p) => [p.slug, p]))
  const currentBySlug = new Map(site.pages.map((p) => [p.slug, p]))
  const missingInBackup = slugs.filter((s) => !backupBySlug.has(s))
  if (missingInBackup.length > 0) {
    throw new Error(
      `备份中没有这些 slug：${missingInBackup.join(', ')}；备份里有：${[...backupBySlug.keys()].join(', ')}`,
    )
  }
  const missingInSite = slugs.filter((s) => !currentBySlug.has(s))
  if (missingInSite.length > 0) {
    throw new Error(
      `当前站点没有这些 slug：${missingInSite.join(', ')}；现有：${[...currentBySlug.keys()].join(', ')}`,
    )
  }

  const expected: Record<string, number> = {}
  for (const slug of slugs) {
    const current = currentBySlug.get(slug)!
    const exported = backupBySlug.get(slug)!
    // 保留当前页 id（重导 overwritePage 保持 id，但快照可能来自更早的轮次），
    // 其余字段（rootNodeId/nodes/title 等）整体回到导出快照——页面树里只有
    // 类名字符串，新样式体系里同名规则自然生效。
    Object.assign(current, exported, { id: current.id })
    expected[slug] = Object.keys(current.nodes).length
    steps.push(`restored ${slug} nodes=${expected[slug]}`)
  }

  await client.saveSite(site, seq)
  steps.push('site-document-saved')

  await client.stepUp()
  steps.push('step-up-ok')

  const pubJson = await client.publish()
  steps.push(`publish-ok ${JSON.stringify(pubJson)}`)

  // 逐页验证：公开页 200 + 持久化后的节点数与回写快照一致。
  const afterPages = await client.loadSite()
  const afterBySlug = new Map(afterPages.site.pages.map((p) => [p.slug, p]))
  const pageChecks: {
    slug: string
    status: number
    htmlLength: number
    nodeCount: number
    expectedNodeCount: number
    ok: boolean
  }[] = []
  for (const slug of slugs) {
    const res = await fetch(client.publicUrl(slug === 'index' ? '/' : `/${slug}`))
    const html = await res.text()
    const nodeCount = afterBySlug.has(slug)
      ? Object.keys(afterBySlug.get(slug)!.nodes).length
      : 0
    const check = {
      slug,
      status: res.status,
      htmlLength: html.length,
      nodeCount,
      expectedNodeCount: expected[slug]!,
      ok: res.status === 200 && html.length > 0 && nodeCount === expected[slug],
    }
    pageChecks.push(check)
  }

  return {
    ok: pageChecks.every((c) => c.ok),
    mode: 'restore' as const,
    slugs,
    pageChecks,
    durationMs: Math.round(performance.now() - t0),
    steps,
    at: new Date().toISOString(),
  }
}

async function main() {
  const { endpoint, rest } = takeEndpointArgs(process.argv.slice(2))
  const { mode, dir, slugs } = parseRunArgs(rest)
  const client = new CmsClient(endpoint)

  const report = mode === 'export'
    ? await runExport(client, dir)
    : await runRestore(client, dir, slugs)

  const reportFile = join(dir, '验证报告-pages-export-restore.json')
  await Bun.write(reportFile, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exit(2)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
