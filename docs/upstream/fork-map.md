# Fork map — instatic-dite vs upstream Instatic

生成于 2026-02。用 `repos/Instatic` 里的 `dite` remote 复算：`git merge-base dite/main HEAD`。

## 当前基准

- **Merge-base = 上游 HEAD `3a9543ed`**（"test(e2e): repair two specs left behind by security fixes #492"）。
- fork 领先 **43** 个提交（其中 32 个非 merge 提交），上游领先 **0**。
- 结论：fork 是上游的严格超集，当前无待评估更新。

## 改造面（43 个提交的归类）

| 模块 | 主要内容 |
|---|---|
| **静态导出 / GitHub Pages 发布**（最大改造面，~17 commits） | `src/core/publisher` 相关导出管线、`POST /admin/api/cms/export-static`、`server/github/`、`server/handlers`（publish/export）、`server/publish/`（pointer-file、样式 URL 重写、媒体收集、holes 展开） |
| **部署 / 运维** | `deploy/`（per-site Compose、nginx、ditexpo/difgc/site3/site4 站点目录）、`docs/deployment/`、备份脚本（`/opt/sites`） |
| **编辑器行为**（~3 commits） | `src/admin`：预览页内链接切换草稿页、canvas 视口单位按断点解析 |
| **媒体 / 站点导入** | 上传 15MB 上限、`base.video` videoUrl/poster 重写 |
| **品牌 / 仓库整理** | rebrand 为 instatic-m、去除上游公共资源、v1.0.0 基线、SpecStory ignore |
| **文档** | 静态导出 Phase A 说明、中文站点维护指南 |

**变更规模**：146 文件，+10619 / −1202。

## 合并风险提示

评估上游新提交时，重点看是否触碰：

1. `src/core/publisher/**`、`server/publish/**` — 静态导出管线与上游发布管线同源，冲突概率最高。
2. `server/handlers/cms/**` 的 publish/export 相关 handler。
3. `src/admin/pages/site/**` 的预览与 canvas 逻辑。
4. rebrand 相关的全局文案/资产 — 上游任何大规模 UI 改动都可能引入需要再次 rebrand 的内容。

## 刷新方式

```sh
cd repos/Instatic
git fetch origin && git fetch dite main
git rev-list --count dite/main..HEAD   # 上游领先数（>0 则需评估）
git log --oneline dite/main..HEAD      # 新提交清单
```
