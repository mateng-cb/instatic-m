# Upstream sync

本目录存放 instatic-dite（fork）与上游 `CoreBunch/Instatic`（本地镜像 `repos/Instatic`）之间的同步状态。流程由 `upstream-sync` skill 驱动。

## 文件

- `fork-map.md` — 分叉地图：fork 的改造面（按模块归类）与同步基准。
- `evaluations/` — 每次上游更新评估一条：`YYYY-MM-<short-slug>.md`。
- `sync-log.md` — 合并历史：何时合到哪个上游 SHA、冲突与处理要点。

## 上游指向

- 上游仓库：https://github.com/CoreBunch/Instatic
- 本地镜像：`repos/Instatic`（已加入 `.gitignore`，勿提交）。其中 `dite` remote 指向本 fork 的 origin，用于共享对象计算 merge-base。
- cbm 索引项目名：`Users-wxd-dev-devops-instatic-dite-repos-Instatic`（fast 模式；graph 查不到的构造用 grep 兜底）。
