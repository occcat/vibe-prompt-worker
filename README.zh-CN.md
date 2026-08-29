# vibe-prompt-worker

[English](README.md) | 简体中文

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/occcat/vibe-prompt-worker)

自托管的 [Cloudflare Worker](https://developers.cloudflare.com/workers/)，用作 **vibe-prompt** 远程保险库。增量密文放在一个 Durable Object（SQLite）里，snapshot 放在 R2。Worker **从不解密**。

一次部署对应一个保险库。第二套保险库必须另部署，并更换 R2 `bucket_name` 或 Cloudflare 账号。

## AUTH_VALUE 与 vaultPassword

| 名称 | 存放位置 | 用途 |
| --- | --- | --- |
| `AUTH_VALUE` | Worker **运行时 Secret** | 客户端访问本 Worker 的同步密码。**不是** Cloudflare API Token。 |
| `vaultPassword` | 仅在客户端 | 内容口令。应用在上传前把对象封成 `VPBE`。Worker 收不到这口令，也不解密。 |

不要把 `AUTH_VALUE` 和 `vaultPassword` 设成同一个值，也不要把 Cloudflare API Token 填进任一栏。

## 一键部署到 Cloudflare

1. 点击上方按钮并登录 Cloudflare。
2. 授权 GitHub，确认仓库副本和 Worker 名称（`vibe-prompt-worker`）。
3. 为 `AUTH_VALUE` 填写足够长的随机字符串。Deploy 按钮会读取 `package.json` 里的绑定说明。
4. 等待 Workers Builds。Wrangler 会按 `wrangler.jsonc` 配置 `VaultObject` Durable Object 和 `vibe-prompt-snapshots` R2 桶。
5. 复制 `https://<worker>.<subdomain>.workers.dev` 地址。
6. 访问 `GET /v1/health`，`"authConfigured"` 应为 `true`。

若 health 显示 `"authConfigured": false`，到 Worker 的 Settings → Variables and Secrets 添加名为 `AUTH_VALUE` 的**运行时** Secret，然后重新部署。只加构建变量时，运行中的 Worker 读不到。

参考：[Deploy to Cloudflare 按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

## 命令行自托管

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

本地开发：

```sh
cp .dev.vars.example .dev.vars
# 在 .dev.vars 中填写 AUTH_VALUE，不要提交该文件
npm start
```

`.dev.vars` 已被 Git 忽略。`.dev.vars.example` 只是空占位。

## Free 与 Paid

下表是单保险库部署需要注意的上限。行大小在两个方案上都是硬限制。

| 限制 | Workers Free | Workers Paid |
| --- | --- | --- |
| Durable Object SQLite（每个对象） | 1 GB | 10 GB |
| SQL 行 / BLOB | **2 MB** | **2 MB** |
| Worker 每请求 CPU | 10 ms | Paid 方案的 CPU 限额 |
| Snapshot | R2 桶 `vibe-prompt-snapshots` | 同一绑定；超出免费额度后按 R2 计费 |

加密对象的体积会远低于 2 MB。Snapshot 进 R2，不进 SQLite BLOB。

**第二套保险库：** 不要让两套部署共用同一个 R2 桶。请改 `wrangler.jsonc` 里的 `r2_buckets[0].bucket_name`，或换账号。

## 当前公开行为

| 请求 | 鉴权 | 结果 |
| --- | --- | --- |
| `GET /` | 无 | `text/plain` 正文 `vibe-prompt-worker` |
| `GET /v1/health` | 无（在 AUTH 之前） | JSON health；`authConfigured` 取决于是否已设置 `AUTH_VALUE` |
| `OPTIONS /v1/share*` | 无 | `204` |
| `/v1/share` 与 `/v1/share/{token}` 的其他方法 | 无（不进 Durable Object） | `404` JSON `not_found` |
| 其余路由且未设置 `AUTH_VALUE` | — | `503` JSON `misconfigured` / `Must set AUTH_VALUE environment.` |

`/v1/share*` 为预留路径。v1 不实现只读分享。

health 的 `capabilities` 目前为 `etag`、`if-match`、`index-atomic`、`batch-push`。不宣传无修饰的 `batch`。

## License

[MIT](LICENSE) © 2026 occcat
