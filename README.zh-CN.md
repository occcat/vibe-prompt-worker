<div align="center">

# vibe-prompt-worker

**自托管的 vibe-prompt 远程保险库。Worker 从不解密。**

<p>
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/occcat/vibe-prompt-worker"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" /></a>
</p>

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DA639?style=for-the-badge" alt="License MIT" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js 22+" /></a>
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" /></a>
</p>

[English](README.md) | 简体中文

</div>

vibe-prompt-worker 是你为自己的 vibe-prompt 保险库部署的 [Cloudflare Worker](https://developers.cloudflare.com/workers/)。增量密文放在一个 Durable Object（SQLite）里，snapshot 放在 R2。Worker 只检查魔数，**从不解密**。

Nextcloud / WebDAV 是 **客户端** 后端，在 vibe-prompt 应用里配置，不在本仓库。本 Worker 是推荐的多设备后端。它不讲 WebDAV，也不是 Nextcloud 应用。

一次部署对应一个保险库。第二套保险库必须另部署，并更换 R2 `bucket_name` 或 Cloudflare 账号。

## 快速开始

### 1. 部署

选一种适合你的方式。

**1.1 一键部署到 Cloudflare**

1. 点击上方 **Deploy to Cloudflare** 并登录。
2. 授权 GitHub，确认仓库副本和 Worker 名称（`vibe-prompt-worker`）。
3. 为 `AUTH_VALUE` 填写足够长的随机字符串。Deploy 按钮会读取 `package.json` 里的绑定说明。
4. 等待 Workers Builds。Wrangler 会按 `wrangler.jsonc` 配置 `VaultObject` Durable Object 和 `vibe-prompt-snapshots` R2 桶。
5. 复制 `https://<worker>.<subdomain>.workers.dev` 地址。

参考：[Deploy to Cloudflare 按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

**1.2 命令行部署**

需要 [Node.js 22](https://nodejs.org/) 或更高版本，以及 Cloudflare 帐号。

```sh
git clone https://github.com/occcat/vibe-prompt-worker.git
cd vibe-prompt-worker
npm ci
npx wrangler login
npm run deploy
npm run secret
```

`npm run secret` 执行 `wrangler secret put AUTH_VALUE`，不会把密码写入仓库。

**1.3 本地运行**

```sh
cp .dev.vars.example .dev.vars
# 在 .dev.vars 中填写 AUTH_VALUE，不要提交该文件
npm start
```

`.dev.vars` 已被 Git 忽略。`.dev.vars.example` 只是空占位。

### 2. 确认健康检查

访问 `GET /v1/health`，`"authConfigured"` 应为 `true`。

若为 `false`，到 Worker 的 Settings → Variables and Secrets 添加名为 `AUTH_VALUE` 的**运行时** Secret，然后重新部署。只加构建变量时，运行中的 Worker 读不到。

### 3. 连接 vibe-prompt

把 Worker URL 填进 vibe-prompt 应用作为远程保险库。同步密码使用同一个 `AUTH_VALUE`。`vaultPassword` 只留在应用里。

不要把 `AUTH_VALUE`、`vaultPassword`、Cloudflare API Token、密文或个人 Worker 地址贴进 issue、pull request 或聊天。

## 亮点

| 特性 | 作用 |
| --- | --- |
| **Worker 从不解密** | 远程对象和 snapshot 都是 `VPBE` 密文。Worker 只检查前四个字节（魔数）。`vaultPassword` 留在设备上。 |
| **一次部署，一个保险库** | 增量密文放在一个 Durable Object（SQLite）。Snapshot 进 R2，不进 SQLite BLOB。 |
| **原生 vibe-prompt 协议** | health 宣传 `etag`、`if-match`、`index-atomic`、`batch-push`。写操作需要 `X-Vibe-Prompt-Protocol: 1`，以及 `If-Match` 或 `If-None-Match`。 |
| **按钮或 Wrangler 都能部署** | Cloudflare Deploy 按钮会配置 Worker、Durable Object 和 R2 桶。命令行是 `npm run deploy` 再加 `npm run secret`。 |
| **同步密码不是内容口令** | `AUTH_VALUE` 是 Worker 运行时 Secret。`vaultPassword` 到不了 Worker。不要把两者设成同一个值，也不要把 Cloudflare API Token 填进任一栏。 |

## 与 Nextcloud / WebDAV

多数 vibe-prompt 方案都能把文件存到某处。真正要问的是：后端是否讲原生协议、主机是否看见明文、以及你能不能在不跑文件服务器的情况下部署。

| 能力 | vibe-prompt-worker | Nextcloud / WebDAV |
| --- | :---: | :---: |
| 原生 vibe-prompt 协议（`etag`、`if-match`、`batch-push`） | ✓ | — |
| 主机从不解密内容 | ✓ | — |
| 一键部署到 Cloudflare | ✓ | — |
| 增量对象放在 Durable Object | ✓ | — |
| Snapshot 不受 2 MB SQL 行限制 | ✓ | 文件 |
| WebDAV | — | ✓ |
| 在本仓库配置 | ✓ | —（在应用里） |
| v1 只读分享 | — | 视配置而定 |

应用里仍然可以使用 Nextcloud / WebDAV。本 Worker 不取代那个客户端后端，也不讲 WebDAV。

## AUTH_VALUE 与 vaultPassword

| 名称 | 存放位置 | 用途 |
| --- | --- | --- |
| `AUTH_VALUE` | Worker **运行时 Secret** | 客户端访问本 Worker 的同步密码。**不是** Cloudflare API Token，也**不是** `CLOUDFLARE_API_TOKEN`。 |
| `vaultPassword` | 仅在客户端 | 内容口令。应用在上传前把远程对象和 snapshot 封成 `VPBE`。Worker 收不到这口令，也不解密。 |

客户端发送 `Authorization: Bearer`，token 为
`SHA-256(UTF-8(AUTH_VALUE) || UTF-8("vibe-prompt-worker-v1"))` 的小写十六进制。
写操作还要带 `X-Vibe-Prompt-Protocol: 1`。

## 加密

Worker 只检查前四个字节（魔数），从不解密。

| 产物 | 默认 | 口令 | 魔数 | 谁强制 |
| --- | --- | --- | --- | --- |
| 本地自动备份（在应用内） | 不加密 | 无 | `VPBP` | 仅应用；本 Worker 不参与 |
| 远程增量对象 | 加密 | `vaultPassword` + vault `kdfSalt` | `VPBE` | `encryption=required` 时 Worker 拒绝非 `VPBE` |
| 远程 snapshot | 加密 | `vaultPassword`（每文件随机 salt） | `VPBE` | `encryption=required` 时 Worker 拒绝非 `VPBE` |
| Tombstone JSON | 仅元数据 | — | 无 | 明文 JSON，无模板正文 |

vault 默认 `encryption` 为 `required`。本地自动备份仍是 `VPBP`，不会存进本 Worker。

R2 对象键为 `{vaultId}/{filename}`。不要让两套部署共用同一个桶。改 `wrangler.jsonc` 里的 `r2_buckets[0].bucket_name`，或换 Cloudflare 账号。

## Free 与 Paid

下表是单保险库部署需要注意的上限。行大小在**两个方案**上都是硬限制。

| 限制 | Workers Free | Workers Paid |
| --- | --- | --- |
| Durable Object SQLite（每个对象） | 1 GB | 10 GB |
| SQL 行 / BLOB | **2 MB** | **2 MB** |
| Worker 每请求 CPU | 10 ms | Paid 方案的 CPU 限额 |
| Snapshot | R2 桶 `vibe-prompt-snapshots` | 同一绑定；超出免费额度后按 R2 计费 |

加密对象硬顶 1,500,000 字节，远低于 2 MB 行限制。Snapshot 进 R2，不进 SQLite BLOB。

**R2 计费：** 本 Worker 不会关闭 R2 收费。超过 [R2 免费额度](https://developers.cloudflare.com/r2/pricing/) 后按 Cloudflare 公布价格计费。

## HTTP API

`/v1/share*` 为预留路径。v1 返回 **404** `not_found`（`OPTIONS` 除外，为 204）。不实现只读分享。这些路径不查 `AUTH_VALUE`，也不进 Durable Object。

health 的 `capabilities` 为 `etag`、`if-match`、`index-atomic`、`batch-push`。**不**宣传无修饰的 `batch`。

`POST /v1/sync/push` 限 **600 对象/分钟**（按对象个数，不是 HTTP 次数；无 burst）。超限整单返回 429 `rate_limited`。没有 60 writes/min 上限。

### 无需鉴权

| 请求 | 结果 |
| --- | --- |
| `GET /` | `text/plain` 正文 `vibe-prompt-worker` |
| `GET /v1/health` | JSON health；`authConfigured` 取决于是否已设置 `AUTH_VALUE` |
| `OPTIONS`（任意路径） | `204` |
| `/v1/share` 与 `/v1/share/{token}` 的其他方法 | `404` JSON `not_found` |
| 其余路由且未设置 `AUTH_VALUE` | `503` JSON `misconfigured` / `Must set AUTH_VALUE environment.` |

### 需要 Bearer

写操作（`PUT` / `POST` / `DELETE`）需要 `X-Vibe-Prompt-Protocol: 1`，以及 `If-Match` 或 `If-None-Match`。

| 请求 | 结果 |
| --- | --- |
| `GET` / `PUT /v1/vault` | Vault JSON（`vibe-prompt.vault/1`） |
| `GET /v1/index` | Index JSON；可选 `?sinceRevision=` |
| `GET` / `PUT` / `DELETE /v1/objects/prompts/{uuid}` | 活 VPBE 提示词 |
| `GET` / `PUT` / `DELETE /v1/objects/labels/{uuid}` | 活 VPBE 标签 |
| `GET` / `PUT` / `DELETE /v1/objects/scopes/{id}` | 活 VPBE 范围 |
| `GET` / `PUT` / `DELETE /v1/objects/tombstones/{kind}:{id}` | Tombstone JSON |
| `GET /v1/snapshots` | Snapshot 列表 |
| `GET` / `PUT` / `DELETE /v1/snapshots/{filename}` | R2 中的 snapshot 正文（不增加 `objectRevision`） |
| `POST /v1/sync/push` | 批量对象 PUT；部分 409 合法 |

这些路由在未设置 `AUTH_VALUE` 时是 503，不是 401。

### v1 未实现

- `PUT /v1/index` → 405（`putIndex` 只存在于应用的 WebDAV 传输）
- `POST /v1/sync/pull` → 404
- `/v1/share*` 只读分享 → 404
- 身份保持的整库恢复

活对象 PUT 超过 **1,500,000** 字节返回 413。Snapshot PUT 超过 **20 MiB** 返回 413。batch-push 的 `Content-Length` 超过 **28 MiB**、超过 **100** 条或解码后超过 **20 MiB** 返回 413。index 超过 8000 条或 4 MiB 返回 507。缺少 R2 绑定时仅 snapshot 路由 503，增量对象仍可用。

## 社区

- [GitHub Issues](https://github.com/occcat/vibe-prompt-worker/issues)，缺陷和具体需求
- [GitHub Discussions](https://github.com/occcat/vibe-prompt-worker/discussions)，问题和想法
- [贡献指南](CONTRIBUTING.md)，提交和评审约定
- [安全](SECURITY.md)，私下报告漏洞

## License

本仓库内容以 [MIT License](LICENSE) 发布。
