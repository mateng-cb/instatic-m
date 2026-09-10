# GitHub Pages 部署（本地推送包）

本指南介绍如何把 Instatic 站点发布到 GitHub Pages：前置条件、PAT 权限、`basePath` 配置、推送包的使用方法，以及管理后台里的设置入口。

GitHub Pages 是**静态托管**——Instatic 不会在 Pages 上运行 Bun 服务器。发布方式是「**本地推送包**」（push kit）：服务器把已发布的快照导出为静态文件、连同推送脚本一起打成 ZIP 供下载；编辑在自己电脑上双击脚本，用本地 `git` 把文件推到 GitHub 仓库。**服务器全程不访问 GitHub API**——没有跨境逐文件上传，也就没有那一环节的超时与限流。本地 Publish（Layer A）必须先成功，推送包才有内容可导。

---

## TL;DR

| 步骤 | 操作 |
|---|---|
| 1 | 在站点编辑器里完成本地 Publish（生成 `uploads/published/current/` 快照） |
| 2 | 确认服务器已设置 `INSTATIC_SECRET_KEY`（PAT 加密存储的前提） |
| 3 | 在 **Settings → Publishing**（或 Publish 对话框）配置仓库 URL、分支、`basePath`，保存 PAT |
| 4 | **Publish → Publish to GitHub…** → 下载 `instatic-push-kit.zip`（需 step-up 验证） |
| 5 | 解压 ZIP，双击 `push.cmd`（Windows）或运行 `bash push.sh`（macOS / Linux）完成推送 |
| 6 | 仓库 **Settings → Pages**：Deploy from a branch → 选目标分支 → `/ (root)` |

| 站点类型 | 典型 URL | `basePath` |
|---|---|---|
| 用户/组织 Pages | `https://user.github.io/` | `""`（留空） |
| 项目 Pages | `https://user.github.io/my-repo/` | `/my-repo` |
| 自定义域名（根域） | `https://www.example.com/` | `""`（留空） |

> ⚠️ `basePath` 必须与仓库的实际访问路径一致：仓库名是 `my-repo`，`basePath` 就必须是 `/my-repo`，否则所有 CSS / 图片 / 脚本都会 404。

---

## 前置条件

### 先完成本地 Publish

推送包读取与静态导出相同的已发布槽位。站点从未发布过时，下载端点返回 **409**，对话框会提示先 Publish。

```text
站点编辑器 → Publish              （Layer A 烘焙到 uploads/published/current/）
           → Publish to GitHub…   （basePath 模式静态导出 + 生成推送脚本 → 下载 ZIP）
           → 本机双击 push.cmd    （git 单 packfile 推送到 GitHub）
```

「Export static site…」是可选的另一条路——同一套 Phase A 管线，默认 `pathMode: 'relative'`。GitHub 推送包固定用 `pathMode: 'basePath'` + 配置的 `basePath` + `directory` 布局（Pages 按目录索引提供 `x/` → `x/index.html`）。

### `INSTATIC_SECRET_KEY`

GitHub PAT 加密存储在 `github_publish_settings`（`server/repositories/githubPublishSettings.ts`），走与其他可逆密钥（AI provider key、MFA seed）相同的 `encryptSecret` / `decryptSecret` 通道。

- 生成：`bun run scripts/generate-secret-key.ts`
- 在服务器上设置后再到后台保存 PAT
- 没有它，PUT settings 会报 master-key 配置错误

API 永远不回传明文 token、密文或 IV——线路上只有 `hasToken` 和 `keyFingerprintCurrent`。

### 个人访问令牌（PAT）

在 GitHub 创建对目标仓库内容有写权限的 PAT：

| 令牌类型 | 所需权限 |
|---|---|
| Classic PAT | `repo` scope，或目标仓库上最小的 **`contents: write`** |
| Fine-grained PAT（推荐） | 仅授权目标仓库；**Contents: Read and write** |

推荐 fine-grained PAT：爆炸半径只限一个仓库，泄漏后可直接撤销。

**后台轮换方式**：PUT 时不带 `token` → 保留现有；空字符串 → 清除；非空 → 替换。

### 本机需要 `git`

推送脚本用本机的 `git` 命令行完成推送（这也是方案的核心：跨境走 git 协议的单 packfile 流，而不是数百个独立 HTTPS API 请求）。Windows 装 [Git for Windows](https://git-scm.com/download/win) 即可——`push.cmd` 会自动调用其内置的 `git.exe`。

---

## 推送包内容

ZIP 根目录：

```text
instatic-push-kit.zip
├── site/          静态导出（index.html、uploads/…、_instatic/…、.nojekyll）
├── push.cmd       Windows 推送脚本（双击运行）
├── push.sh        macOS / Linux 推送脚本（bash push.sh）
└── README.txt     中文使用说明（含目标仓库、分支、页数、凭证状态）
```

脚本做的事：在 `site/` 里 `git init` → 提交全部文件 → `git push -f origin <branch>`。**force push 整树替换**——每次推送都是全新历史，不会和远端产生合并冲突；远端分支不存在时会自动创建（无需预先建空分支）。推送结束后脚本会 `git remote remove origin`，把含凭证的 remote 从本地配置里清掉。

每个包都带根级 **`.nojekyll`** 标记。GitHub Pages 默认跑 Jekyll，而 Jekyll 会丢弃 `_` 前缀路径——Instatic 的资产都在 `_instatic/` 下，没有这个标记所有样式和运行时脚本都会 404。

### Token 嵌入选项

下载对话框里的「在脚本中嵌入访问令牌」开关（默认开）决定推送是否需要交互：

| 选项 | 行为 | 适用 |
|---|---|---|
| 嵌入（默认） | PAT 写入脚本里的 remote URL（`https://<token>@github.com/...`），双击即推，零交互 | ZIP 只发给内部人员/自己 |
| 不嵌入 | 首次推送弹出 GitHub 登录/浏览器授权（凭本机 git 凭证管理器） | ZIP 需要外发或长期保存 |

> ⚠️ **嵌入版 ZIP 等同于一把仓库钥匙**——拿到它的人可以直接推代码到目标仓库。只通过可信渠道分发；建议配合 fine-grained PAT 把权限锁到单个仓库。

---

## 仓库设置

### 启用 GitHub Pages

第一次推送成功后，在仓库 **Settings → Pages**：

| 设置 | 值 |
|---|---|
| Source | Deploy from a branch |
| Branch | 与 Instatic **Branch** 字段相同的分支（默认 `gh-pages`） |
| Folder | `/ (root)` |

Instatic 不会调用 Pages 启用 API——推送后手动启用一次。自定义域名也在 Pages 设置里配；站点挂在域名根路径时 `basePath` 留空（见上文表格）。

### 分支保护

脚本用 force push 整树替换。如果目标分支在 GitHub 上开了分支保护（包括把默认分支当作推送目标），force push 会被拒绝——推送目标请用专用的 `gh-pages` 之类分支，不要推到受保护的 `main`。

---

## 后台配置

两个入口共用同一行持久化配置（`github_publish_settings`，单例 `id = 'default'`）：

| 位置 | 用途 |
|---|---|
| **Settings → Publishing** → GitHub Pages 块 | 保存默认值和 PAT（`putGithubPublishSettings`）。不下载、不推送。 |
| **站点编辑器 → Publish 菜单 → Publish to GitHub…** | `GithubPublishDialog` —— 加载配置、可修改后保存、选择是否嵌入 token、下载推送包 |

字段：

| 字段 | 含义 |
|---|---|
| Repository URL | 如 `https://github.com/owner/repo`（由 `server/github/parseRepoUrl.ts` 解析） |
| Branch | 推送目标分支（默认 `gh-pages`；只允许字母、数字、`.`、`_`、`-`、`/`） |
| Base path | 资产 URL 重写前缀——项目 Pages 填 `/my-repo`，用户/组织站或根域名留空 |
| PAT | 加密存储；已保存时显示 "Token saved" |

下载推送包需要 `pages.publish` 能力 + step-up（与本地 Publish、静态导出 ZIP 同级）。

---

## HTTP API（运维参考）

| 方法 | 路径 | 权限 |
|---|---|---|
| `GET` | `/admin/api/cms/github-publish/settings` | `pages.publish` |
| `PUT` | `/admin/api/cms/github-publish/settings` | `pages.publish` |
| `POST` | `/admin/api/cms/github-publish/push-package` | `pages.publish` + step-up |

Handler：`server/handlers/cms/githubPublish.ts`。客户端助手：`src/core/persistence/cmsGithubPublish.ts`。

`POST push-package` body `{ "embedToken": boolean }`（默认 `false`），同步构建并流式返回 ZIP（`application/zip` + `Content-Disposition: attachment; filename="instatic-push-kit.zip"`）。没有后台任务、没有轮询——问题域是一次下载。

| 状态码 | 原因 |
|---|---|
| `200` | 成功，返回 ZIP 流 |
| `400` | 仓库未配置 / 嵌入 token 但服务器没存 PAT / 配置非法 |
| `409` | 站点尚未本地 Publish |
| `422` | 导出中止——存在 per-visitor 动态洞（同静态导出） |

---

## 范围外

- GitHub App 安装令牌
- 非 GitHub 主机（GitLab、Codeberg……）
- 通过 API 自动启用 GitHub Pages
- 服务器端直推（已废弃：跨境逐文件调 Git Data API 的方案在大陆网络环境下不可用，由本推送包方案取代）

---

## 相关

- [docs/features/publisher.md](../features/publisher.md) —— 发布管线、静态导出（Phase A）、GitHub 推送包（Phase B）
- [docs/deployment/README.md](README.md) —— 部署索引与 `INSTATIC_SECRET_KEY`
- 事实源文件：
  - `server/publish/localPushKit.ts` —— 推送包打包器（导出 + 脚本 + README）
  - `server/repositories/githubPublishSettings.ts` —— 配置 + PAT 加密
  - `server/handlers/cms/githubPublish.ts` —— HTTP 路由
  - `src/admin/modals/GithubPublishDialog/GithubPublishDialog.tsx` —— 下载对话框
  - `src/admin/modals/Settings/sections/PublishingSection.tsx` —— 设置块
- 测试：`src/__tests__/server/localPushKit.test.ts`、`src/__tests__/server/githubPublishSettings.test.ts`、`src/__tests__/server/cmsGithubPublish.test.ts`
