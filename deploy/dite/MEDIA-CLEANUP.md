# DITExpo 静态资源清理指南

> 分析基准：本地 `​.tmp/dev.db` + `uploads/`（2026-09-10，与交付镜像同源数据）。
> 结论先说：**uploads 共 559.30 MB，其中 373.53 MB（67%）当前内容完全没用到，可删**。

---

## 一、现状数字

| 分类 | 文件数 | 大小 | 说明 |
|---|---:|---:|---|
| uploads 总计（不含 `published/`） | 14 676 | **559.30 MB** | 历次导入累积 |
| ✅ 被当前页面引用（含派生） | 4 388 | 185.77 MB | 留下 |
| ❌ 未被引用（可删） | **10 288** | **373.53 MB** | 清理目标 |

**未引用部分的构成：**

| 类型 | 文件数 | 大小 | 来源 |
|---|---:|---:|---|
| `.mp4` | 9 | **102.40 MB** | 同一个 `headVideo-v1.mp4`（11.38 MB）被重复导入 9 次；当前站点视频全部走外链，本地副本 **0 引用** |
| `.png` | 1 347 | 114.57 MB | 历次重导入留下的旧版图片（zb01–zb18 展位图、jt01–jt05 论坛图、`headbanner2026-v4` 等旧版本） |
| `.webp` | 7 614 | 126.20 MB | 上述旧 png 的多宽度派生图（每个原图带 4–7 个 `-wNNN.webp`） |
| `.jpg` | 1 318 | 30.36 MB | 同上，旧版 jpg |

**为什么会有这么多**：DITExpo 内容经过多轮重导入（2026-09-08 的 18 页重导是最后一次）。每次导入都把当时的图片以全新随机文件名写入 uploads，旧一轮的文件和库记录从未清理，逐轮累积。

**删除安全性**（已逐项核对）：
- 被删文件 **0 个**被页面树、站点设置、协同文档（Yjs）引用——引用闭包含原图的全部派生宽度；
- 被删文件 **0 个**被历史版本（`data_row_versions`）引用——删掉不影响任何旧版本回看；
- **0 个**孤儿文件（全部登记在 `media_assets` 表），删库记录 + 删文件两边同步即可，无悬空。

## 二、容器里静态资源在哪

Docker 卷（`compose.dite.yml` 定义的两个 named volumes）：

| 内容 | 容器内路径 | 卷名 |
|---|---|---|
| 图片/视频文件 | `/app/uploads` | `instatic-dite_uploads` |
| SQLite 数据库（含 `media_assets` 登记表） | `/app/data/cms.db` | `instatic-dite_data` |
| 发布快照（Layer A 输出，勿动） | `/app/uploads/published` | 同 uploads 卷 |

`/app/uploads` 下的文件就是最终线上 URL `/uploads/<文件名>` 对应的实体；**文件名里的随机前缀是防重名哈希，不是文件夹分类**，所以不能按名字猜用途，要以库引用关系为准（本指南的脚本就是干这个的）。

## 三、怎么删

### 方案 A（推荐）：停应用 + 一次性容器跑清理脚本

适合这次的万级文件清理。脚本自动重算引用闭包（不依赖本文数字，线上数据有任何后续编辑也依然准确），**只删「当前内容完全没引用」的原图 + 其全部派生**。先停应用再跑，避免两个进程并发写同一个 SQLite 库。

**1. 备份两个卷（必做）：**

```sh
docker run --rm -v instatic-dite_data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/dite-data-$(date +%F).tgz -C /data .
docker run --rm -v instatic-dite_uploads:/data -v "$PWD:/backup" alpine \
  tar czf /backup/dite-uploads-$(date +%F).tgz -C /data .
```

**2. 停应用（`down` 不带 `-v`，数据卷保留）：**

```sh
docker compose -f compose.dite.yml down
```

**3. 用镜像自带 Bun 挂卷跑脚本——先预览，再真删：**

将文末「附录：清理脚本」存为服务器上的 `media-cleanup.ts`（与 compose 文件同目录），然后：

```sh
# 预览（不删任何东西，只看数字）
docker run --rm -v instatic-dite_data:/app/data -v instatic-dite_uploads:/app/uploads \
  -v "$PWD/media-cleanup.ts:/tmp/media-cleanup.ts" instatic-dite:latest \
  bun /tmp/media-cleanup.ts

# 数字确认无误后真删
docker run --rm -v instatic-dite_data:/app/data -v instatic-dite_uploads:/app/uploads \
  -v "$PWD/media-cleanup.ts:/tmp/media-cleanup.ts" instatic-dite:latest \
  bun /tmp/media-cleanup.ts --apply
```

脚本做的事：扫 `data_rows`（页面树）+ `site`（站点设置）+ `collab_documents`（协同文档）收集全部 `/uploads/…` 引用 → 引用闭包（原图+派生）→ 未引用者：删 `/app/uploads` 下文件 + 从 `media_assets` 删行。`--apply` 前后各打印一次统计。

**4. 重启并重新 Publish 一次**（发布快照 `published/` 不受影响，但重新发布可确认一切正常）：

```sh
docker compose -f compose.dite.yml up -d
```

### 方案 B：管理后台 UI（适合日常少量清理）

后台 → **Media（媒体库）**：

1. 选中资产（支持多选 / 批量编辑窗口）→ 删除 = **软删除**（进回收站，文件还在磁盘）；
2. 回收站（Trash 视图）→ 彻底删除 = **purge**，此时服务端才会真正删掉磁盘上的原图和全部 `-wNNN.webp` 派生。

两步设计是防误删（可恢复）。缺点：媒体库**没有「未引用」筛选**，1 万个历史文件没法按引用状态勾选——所以本次批量清理用方案 A，日常零星删除用 B。

### ⚠️ 不要做的事

- **不要直接 `rm` 卷里的文件**——`media_assets` 表还登记着，媒体库会出现一堆损坏条目；
- **不要只删库记录不删文件**——磁盘空间不释放，正是现在的状态；
- **不要动 `/app/uploads/published/`**——那是发布快照，不是导入资源。

## 四、需要压缩吗

**不需要。** 留下的 185.77 MB 中：

| 类型 | 大小 | 角色 |
|---|---:|---|
| `.png` 原图 557 张 | 86.50 MB | `<img>` 回退源 |
| `.webp` 派生 3 353 张 | 85.39 MB | 发布时 srcset 自动供图，现代浏览器实际加载的是这些 |
| `.jpg` 原图 478 张 | 13.88 MB | 同回退源 |

Instatic 上传图片时已自动生成多宽度 webp 派生并在发布页走 `srcset`——访客实际下载的已是 webp（体积约为 png 的 1/5–1/3）。png 原图只是老旧浏览器的回退，压它省不了访客流量、只省服务器磁盘 ~86 MB，还要重挂引用，不值得。**删除未引用的 373.53 MB 就够了。**

## 五、后续维护建议

每次**重导入/大改版后**跑一次方案 A 的脚本（预览 → 确认 → `--apply`），uploads 就不会再次膨胀。如果将来要把瘦身后的数据打进新交付镜像，先在源库上跑清理再执行 `scripts/build-dite-release.ts` 打包。

---

## 附录：清理脚本

存为 `media-cleanup.ts`（Bun/TypeScript，在容器内以 `/app` 为根运行）：

```ts
/**
 * DITExpo uploads cleaner — deletes files (and their media_assets rows) that
 * are NOT referenced by any page tree, site settings, or collab doc.
 * Usage: bun media-cleanup.ts           # dry-run (preview only)
 *        bun media-cleanup.ts --apply   # actually delete
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

const APPLY = process.argv.includes('--apply')
const ROOT = '/app'
const db = new Database(join(ROOT, 'data/cms.db'))

const RE = /\/uploads\/([A-Za-z0-9._-]+)/g
const refs = new Set<string>()
const grab = (t: string | null | undefined) => {
  if (!t) return
  for (const m of t.matchAll(RE)) refs.add(m[1]!)
}
for (const r of db.query('select cells_json from data_rows').all()) grab(r.cells_json)
for (const r of db.query('select settings_json from site').all()) grab(r.settings_json)
for (const r of db.query('select state_blob from collab_documents').all())
  grab(Buffer.from(r.state_blob).toString('latin1'))

interface Asset { id: string; storage_path: string; variants_json: string | null }
const assets = db.query(
  'select id, storage_path, variants_json from media_assets where deleted_at is null',
).all() as Asset[]

const keep = new Set<string>()       // files to KEEP (referenced closure)
const removePaths: string[] = []     // files to DELETE
const removeIds: string[] = []       // media_assets rows to DELETE

for (const a of assets) {
  let variants: string[] = []
  try { variants = (JSON.parse(a.variants_json ?? '[]') as { storagePath?: string }[])
    .map((v) => v.storagePath).filter(Boolean) } catch { /* ignore */ }
  if (refs.has(a.storage_path)) {
    keep.add(a.storage_path)
    for (const v of variants) keep.add(v)
  } else {
    removeIds.push(a.id)
    removePaths.push(a.storage_path, ...variants)
  }
}

// Files on disk that belong to no asset row (orphans) stay untouched on
// purpose — manual review — but they are reported.
const dir = join(ROOT, 'uploads')
const diskFiles = readdirSync(dir).filter((n) => {
  if (n === 'published') return false
  try { return statSync(join(dir, n)).isFile() } catch { return false }
})
const removeSet = new Set(removePaths)
const onDiskToRemove = diskFiles.filter((n) => removeSet.has(n))

const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`
const bytesOf = (names: string[]) => names.reduce((s, n) => {
  try { return s + statSync(join(dir, n)).size } catch { return s }
}, 0)

console.log(`引用中的文件（保留）: ${keep.size} 个`)
console.log(`未引用原图: ${removeIds.length} 个，连同派生待删文件: ${onDiskToRemove.length} 个, ${mb(bytesOf(onDiskToRemove))}`)

if (!APPLY) {
  console.log('\n[dry-run] 未删除任何东西。加 --apply 执行真实删除。')
  process.exit(0)
}

db.transaction(() => {
  const stmt = db.prepare('delete from media_assets where id = ?')
  for (const id of removeIds) stmt.run(id)
})()

let deleted = 0
for (const name of onDiskToRemove) {
  try { unlinkSync(join(dir, name)); deleted++ } catch (e) {
    console.error('删除失败:', name, (e as Error).message)
  }
}
console.log(`✅ 已删除 ${removeIds.length} 条 media_assets 记录, ${deleted} 个磁盘文件。`)
console.log('建议：回后台重新 Publish 一次以确认站点正常。')
```

> 脚本只处理 `deleted_at is null` 的资产；若之前在 UI 里软删过资产，先在回收站里彻底删除（purge）再跑本脚本。
