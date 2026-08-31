<div align="center">

# vibe-prompt-worker

**为 vibe-prompt 自托管的 R2 快照服务。**

[English](README.md) | 简体中文

</div>

Worker 负责客户端鉴权，并把完整的加密 `VPBE` 快照存入 Cloudflare R2。
R2 是唯一数据源，不再存在对象级同步数据库、Durable Object、dirty set、
tombstone、索引或批量推送 API。

一个部署代表一个远端保险库。第二套保险库应使用另一套部署和 R2 桶。

## 部署

需要 Node.js 22 或更高版本以及 Cloudflare 帐号。

```sh
npm ci
npx wrangler login
npm run deploy
npm run secret
```

`npm run secret` 会把 `AUTH_VALUE` 写入 Worker Secret。
它应是足够长的随机值，且不能提交到仓库。
客户端使用下式生成小写十六进制 Bearer token：

```text
SHA-256(UTF-8(AUTH_VALUE) || UTF-8("vibe-prompt-worker-v1"))
```

这里继续使用 `v1` salt，以保持已有连接密码有效；它不代表 HTTP 协议版本。

默认 R2 绑定名为 `SNAPSHOTS`，对应 `vibe-prompt-snapshots` 桶。需要时可以修改
`wrangler.jsonc` 中的桶名。

### 升级警告

v2 部署会通过 Wrangler migration 删除旧 `VaultObject` Durable Object 类及其中的
SQLite 数据，并且不会迁移 v1 对象同步数据。
v2 只读取 `snapshots/` 前缀和 `head.json`，因此旧版 R2 key 会被忽略；
全部客户端升级后，可按需清理这些旧 key。

## v2 协议

`GET /v2/health` 和 `GET /` 无需鉴权，`OPTIONS` 也无需鉴权。
其余接口都需要派生后的 Bearer token。写操作还必须发送：

```text
X-Vibe-Prompt-Protocol: 2
```

读请求若显式提供其他版本的协议头，也会被拒绝。
所有 `/v1` 路由都返回 `404`。

错误使用稳定的 JSON 外壳：

```json
{"error":{"code":"not_found","message":"Not Found"}}
```

### 健康检查

`GET /v2/health` 返回 `vibe-prompt.health/2`、协议版本 `2`、后端 `r2-snapshot`，以及
`snapshot-head`、`snapshot-history`、`etag` 和 `if-match` 能力。

### 不可变快照

| 请求 | 行为 |
| --- | --- |
| `GET /v2/snapshots` | 按从新到旧列出历史。 |
| `PUT /v2/snapshots/{filename}` | 创建一个不可变的加密快照。 |
| `GET /v2/snapshots/{filename}` | 下载加密快照并返回 `ETag`。 |
| `DELETE /v2/snapshots/{filename}` | 使用匹配的 `ETag` 删除非当前快照。 |

快照文件名必须符合：

```text
vibe-prompt-(auto|backup)_YYYYMMDDTHHMMSSZ_<8 位小写十六进制>_<6 位小写十六进制>.vpb
```

上传要求：

- `Content-Type: application/octet-stream`
- `If-None-Match: *`
- `X-Vibe-Prompt-Protocol: 2`
- 前四个字节为 `VPBE`
- 不超过 20 MiB；没有 `Content-Length` 时也会校验真实正文大小

同名快照已存在时返回 `412 precondition_failed`，绝不覆盖。列表 schema 为
`vibe-prompt.snapshots/2`，每项包含 `name`、`size`、`createdAt`、`etag` 和 `isHead`。

删除必须使用服务返回的带引号 ETag 作为 `If-Match`。
过期 ETag 返回 `412`；删除当前 head 指向的快照返回 `409 snapshot_is_head`。

### 当前 head

`GET /v2/head` 返回当前指针及其 R2 ETag：

```json
{
  "schema": "vibe-prompt.head/2",
  "snapshot": "vibe-prompt-auto_20260831T120000Z_0123abcd_456789.vpb",
  "updatedAt": "2026-08-31T12:00:00.000Z"
}
```

首次 `PUT /v2/head` 使用 `If-None-Match: *`，之后更新必须使用最新 `If-Match` ETag。
请求媒体类型为 `application/json`，正文包含相同 schema 和 `snapshot`；
服务端生成 `updatedAt`。目标快照必须已经存在。并发或过期写返回 `412`，
客户端应重新获取状态，避免静默覆盖其他设备。

## 开发

```sh
npm start
npm test
npm run typecheck
npm run build
```

`npm run build` 只执行 Wrangler dry-run，不会部署。

## 安全

快照必须由客户端先加密。Worker 会检查 `VPBE` 魔数，
但无法验证密文内部内容。
不要公开 `AUTH_VALUE`、解密后的备份、客户端保险库密码或
Cloudflare API token。
详见 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)
