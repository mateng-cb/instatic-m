# Instatic DITE 站点 — 部署说明

## 包内文件

| 文件 | 作用 |
|---|---|
| `instatic-dite.tar` | Docker 镜像，**已内置 DITE 站点全部数据**（页面、媒体、管理员账号） |
| `compose.dite.yml` | 启动配置 |
| `.env` | 服务端密钥（库内 GitHub 发布令牌等机密靠它解密）——**机密文件，勿放公开渠道** |
| `DEPLOY.md` | 本文件 |

## 部署（三条命令）

前置：服务器已安装 Docker（含 compose 插件）。把四个文件放到服务器同一目录，然后：

```sh
# 1. 载入镜像（约 2 GB，首次约 1–2 分钟）
docker load -i instatic-dite.tar

# 2. 启动（首次启动自动把站点数据初始化进数据卷）
docker compose -f compose.dite.yml up -d

# 3. 确认健康
curl http://127.0.0.1:3001/health
```

访问：

- 管理后台 `http://<服务器IP>:3001/admin` —— 账号密码与打包方本地一致，**拿到后请立即在后台修改密码**
- 对外站点 `http://<服务器IP>:3001/`

## 数据在哪里、怎么不会丢

- 站点数据在两个 Docker 数据卷里：`instatic-dite_data`（数据库）、`instatic-dite_uploads`（媒体与发布产物）
- 首次 `up` 时 Docker 自动把镜像内置的站点数据复制进数据卷，之后一切修改都写数据卷
- `docker compose -f compose.dite.yml down` 停止服务但**保留数据**；`down -v` 会**清空全部数据**，慎用

## 更新版本（拿到新的 instatic-dite.tar 时）

```sh
docker load -i instatic-dite.tar
docker compose -f compose.dite.yml up -d
```

注意：新镜像携带的是**打包那一刻**的站点数据；只有数据卷还是空的情况下才会用镜像数据初始化。服务器上已在运营的站点，数据始终以服务器数据卷为准，不会被新镜像覆盖。

## 常见问题

- **想换端口**：在同目录 `.env` 追加一行 `HOST_PORT=8080`，然后 `docker compose -f compose.dite.yml up -d`
- **前面有 Nginx / 网关（HTTPS）**：在 `.env` 追加 `PUBLIC_ORIGIN=https://你的域名`（CSRF 校验需要）；如需审计日志记录真实访客 IP，再加 `TRUSTED_PROXY_CIDRS=172.16.0.0/12`
- **看日志**：`docker compose -f compose.dite.yml logs -f app`
- **备份**：两个数据卷都要备，示例：
  ```sh
  docker run --rm -v instatic-dite_data:/data -v "$PWD:/backup" alpine \
    tar czf /backup/dite-data-$(date +%F).tgz -C /data .
  docker run --rm -v instatic-dite_uploads:/data -v "$PWD:/backup" alpine \
    tar czf /backup/dite-uploads-$(date +%F).tgz -C /data .
  ```
