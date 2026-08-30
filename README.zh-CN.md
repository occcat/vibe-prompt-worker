<div align="center">

# vibe-prompt-worker

**为自托管 vibe-prompt 远程保险库部署的 Cloudflare Worker。**

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

vibe-prompt-worker 是你为自己的 vibe-prompt 保险库部署的 [Cloudflare Worker](https://developers.cloudflare.com/workers/)。增量密文放在一个 Durable Object（SQLite）里，snapshot 放在 R2。

一次部署对应一个保险库。第二套保险库必须另部署，并更换 R2 `bucket_name` 或 Cloudflare 账号。

## 快速开始

### 1. 部署

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

不要写进 issue、pull request 或聊天的内容见 [SECURITY.md](SECURITY.md)。

## AUTH_VALUE 与 vaultPassword

| 名称 | 存放位置 | 用途 |
| --- | --- | --- |
| `AUTH_VALUE` | Worker **运行时 Secret** | 客户端访问本 Worker 的同步密码。**不是** Cloudflare API Token，也**不是** `CLOUDFLARE_API_TOKEN`。 |
| `vaultPassword` | 仅在客户端 | 内容口令。应用在上传前加密远程对象和 snapshot。 |

客户端发送 `Authorization: Bearer`，token 为
`SHA-256(UTF-8(AUTH_VALUE) || UTF-8("vibe-prompt-worker-v1"))` 的小写十六进制。
写操作发送 `X-Vibe-Prompt-Protocol: 1`。

## 加密

vault 的 `encryption` 为 `required` 时，Worker 检查活对象和 snapshot 的前四个字节是否为 `VPBE` 魔数。`optional` 与 `forbidden` 跳过该检查。若保险库文档尚不存在，活对象 PUT 按 `encryption=required` 处理。

Vault JSON（`vibe-prompt.vault/1`）必须把 `snapshotRetention.maxCount` 设为 `30`、`maxBytes` 设为 `629145600`。`encryption` 为 `required`、`optional` 或 `forbidden`。创建后不能改 `vaultId` 和 `kdfSalt`。

Tombstone 是 JSON（`vibe-prompt.tombstone/1`），不是 `VPBE`。

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

所有响应都带 `Access-Control-Allow-Origin: *`。

health JSON 的 schema 为 `vibe-prompt.health/1`。`capabilities` 为 `etag`、`if-match`、`index-atomic`、`batch-push`（没有 `batch`）。`authConfigured` 取决于是否已设置 `AUTH_VALUE`。

缺少 `X-Vibe-Prompt-Protocol` 时，仅 `PUT` / `POST` / `DELETE` / `PATCH` 返回 400 `invalid_protocol`。若该头存在且不是 `1`，GET 也返回 400。

保险库路由未设置 `AUTH_VALUE` 时返回 503 `misconfigured`（`Must set AUTH_VALUE environment.`）。缺少 `Authorization: Bearer` 返回 401 `unauthorized`（`Missing Authorization bearer token.`）。Bearer 无效返回 403 `forbidden`（`Sorry, you have supplied an invalid key.`）。

对 vault、对象和 snapshot 的 PUT 需要 `If-Match` 或 `If-None-Match`（两者都没有则 428 `precondition_required`）。DELETE 只需要 `If-Match`。`POST /v1/sync/push` 的 POST 本身不要求这些头；每条 item 自带 `ifMatch` / `ifNoneMatch`。

snapshot 文件名必须匹配 `vibe-prompt-(auto|backup)_YYYYMMDDTHHMMSSZ_<8hex>_<6hex>.vpb`，否则 400 `invalid_path`。写入第 31 个 `auto_` snapshot 会 GC 掉最旧的 `auto_`，保留 30 个 auto；`backup_` snapshot 保留。

`POST /v1/sync/push` 限 **600 对象/分钟**（按对象个数，不是 HTTP 次数；无 burst）。超限整单返回 429 `rate_limited`。单次 PUT/DELETE 不受该限额。

活对象 PUT 达到 **1,500,000** 字节返回 413 `payload_too_large`。Snapshot PUT 仅在 Worker 边缘看到 `Content-Length` 超过 **20 MiB** 时返回 413。batch-push 的 `Content-Length` 超过 **28 MiB**、超过 **100** 条或解码后超过 **20 MiB** 返回 413。index 超过 8000 条或 4 MiB canonical JSON 返回 507 `index_too_large`。缺少 R2 绑定时仅 snapshot 路由 503，增量对象仍可用。

### 无需鉴权

| 请求 | 结果 |
| --- | --- |
| `GET /` | `text/plain` 正文 `vibe-prompt-worker` |
| `GET /v1/health` | JSON health；`authConfigured` 取决于是否已设置 `AUTH_VALUE` |
| `OPTIONS`（任意路径） | `204` |
| `/v1/share` 与 `/v1/share/{token}`（`OPTIONS` 除外） | `404` JSON `not_found`（不查 `AUTH_VALUE`，不进 Durable Object） |
| 其余保险库路由且未设置 `AUTH_VALUE` | `503` JSON `misconfigured` / `Must set AUTH_VALUE environment.` |

### 需要 Bearer

| 请求 | 结果 |
| --- | --- |
| `GET` / `PUT /v1/vault` | Vault JSON（`vibe-prompt.vault/1`） |
| `GET /v1/index` | Index JSON；可选 `?sinceRevision=` |
| `PUT /v1/index` | `405` `method_not_allowed` |
| `GET` / `PUT` / `DELETE /v1/objects/prompts/{uuid}` | 活 VPBE 提示词 |
| `GET` / `PUT` / `DELETE /v1/objects/labels/{uuid}` | 活 VPBE 标签 |
| `GET` / `PUT` / `DELETE /v1/objects/scopes/{id}` | 活 VPBE 范围 |
| `GET` / `PUT` / `DELETE /v1/objects/tombstones/{kind}:{id}` | Tombstone JSON |
| `GET /v1/snapshots` | Snapshot 列表 |
| `GET` / `PUT` / `DELETE /v1/snapshots/{filename}` | R2 中的 snapshot 正文（不增加 `objectRevision`） |
| `POST /v1/sync/push` | 批量对象 PUT；部分 409 合法 |
| `POST /v1/sync/pull` | 鉴权后 `404` `not_found` |

## 社区

- [GitHub Issues](https://github.com/occcat/vibe-prompt-worker/issues)，缺陷和具体需求
- [GitHub Discussions](https://github.com/occcat/vibe-prompt-worker/discussions)，问题和想法
- [贡献指南](CONTRIBUTING.md)，提交和评审约定
- [安全](SECURITY.md)，私下报告漏洞

## License

本仓库内容以 [MIT License](LICENSE) 发布。
