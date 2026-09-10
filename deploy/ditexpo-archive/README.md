# ditexpo 专题归档方案（ditexpo.com/年份 路径访问）

纯静态专题站的多年归档方案：每年一个 GitHub 仓库 + 一个 Cloudflare Pages 项目，
主域永远指向当前年度项目，Worker 把 `/2025` 等年份路径反代到对应归档项目。

## 一次性初始化

1. **归档 2025**
   ```sh
   bun run deploy/ditexpo-archive/prepare-archive.ts --src <2025导出包目录> --year 2025 --out /tmp/ditexpo-2025
   cd /tmp/ditexpo-2025 && git init && git add -A && git commit -m "2025 archive snapshot"
   # 推到 GitHub 仓库 ditexpo-2025，Cloudflare Pages 建同名项目连仓库，不绑自定义域名
   ```
2. **当前 2026**：导出包直接作为 `ditexpo-2026` 仓库/项目内容，该项目绑定 `ditexpo.com`。
3. **Worker**：`cd deploy/ditexpo-archive && npx wrangler deploy`（路由已在 wrangler.toml）。
   部署后访问 `ditexpo.com/2025` → 2025 归档；`ditexpo.com/` → 2026。

## 每年轮换（例：2027 上线）

1. 2026 导出包跑 `prepare-archive.ts --year 2026`，推入新仓库 `ditexpo-2026-archive`，
   建 Pages 项目，不绑域名。
2. 新专题包推入仓库 `ditexpo-2027`，其 Pages 项目**接管绑定 `ditexpo.com`**；
   旧项目解绑域名。
3. `worker.ts` 的 `ROUTES` 加一行 `2026: "ditexpo-2026.pages.dev"`，重新 `wrangler deploy`。

## 原理与限制

- Pages/Workers 单文件上限 25MiB、单项目 20,000 文件——每个年度项目独立享额度，
  `prepare-archive.ts` 会预检超大文件。
- 脚本把快照内根相对引用 `/xxx` 改写为 `/2025/xxx`，Worker 剥前缀后命中归档项目，
  因此快照自包含，两届资源不会在主域下冲突。
- Worker 免费版 100,000 请求/天，归档流量场景绰绰有余。
- 归档快照为纯静态（无 `<instatic-hole>` 回源），发布后冻结，不再消耗构建次数。
