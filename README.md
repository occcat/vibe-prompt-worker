<div align="center">

# vibe-prompt-worker

**A self-hosted R2 snapshot service for vibe-prompt.**

[简体中文](README.zh-CN.md) | English

</div>

The Worker authenticates clients and stores complete encrypted `VPBE` snapshots in Cloudflare
R2. R2 is the only data store. A single `manifest.json` atomically owns the visible snapshot
catalog and current head; snapshot bodies remain immutable objects. There is no object-level sync
database, Durable Object, dirty set, tombstone, index, or batch push API.

One deployment represents one remote vault. Use a separate deployment and R2 bucket for another
vault.

## Deploy

Requirements: Node.js 22 or later and a Cloudflare account.

```sh
npm ci
npx wrangler login
npm run deploy
npm run secret
```

`npm run secret` stores `AUTH_VALUE` as a Worker secret. It must be a long random value and must
not be committed. The client derives its Bearer token as lowercase hex:

```text
SHA-256(UTF-8(AUTH_VALUE) || UTF-8("vibe-prompt-worker-v1"))
```

The salt remains `v1` so existing connection passwords stay valid. It does not indicate the HTTP
protocol version.

The default R2 binding is `SNAPSHOTS`, backed by the `vibe-prompt-snapshots` bucket. Change the
bucket name in `wrangler.jsonc` when necessary.

### Upgrade warning

The v2 deployment intentionally deletes the old `VaultObject` Durable Object class and its SQLite
data through a Wrangler migration. It does not migrate v1 object-sync data. Existing R2 keys from
v1 are ignored because v2 uses `manifest.json`, generation keys under `bodies/`, and bounded GC
state. Delete old keys after all clients have upgraded if they are no longer needed.

## Protocol v2

`GET /v2/health` and `GET /` do not require authentication. `OPTIONS` is also unauthenticated. All
other routes require the derived Bearer token. Write operations also require:

```text
X-Vibe-Prompt-Protocol: 2
```

Providing a different protocol header on a read is rejected. Every `/v1` route returns `404`.

Errors use a stable JSON envelope:

```json
{"error":{"code":"not_found","message":"Not Found"}}
```

Every `/v2` response includes `Cache-Control: no-store, no-transform`. This keeps Cloudflare and
other intermediaries from compressing or otherwise transforming bytes associated with strong
integrity and CAS ETags.

### Health

`GET /v2/health` returns `vibe-prompt.health/2`, protocol version `2`, backend `r2-snapshot`, and
the `snapshot-head`, `snapshot-history`, `etag`, and `if-match` capabilities.

### Immutable snapshots

| Request | Behavior |
| --- | --- |
| `GET /v2/snapshots` | Lists history newest first. |
| `PUT /v2/snapshots/{filename}` | Creates one immutable encrypted snapshot. |
| `GET /v2/snapshots/{filename}` | Streams the encrypted snapshot and its `ETag`. |
| `DELETE /v2/snapshots/{filename}` | Deletes a non-current snapshot with a matching `ETag`. |

Snapshot filenames must match:

```text
vibe-prompt-(auto|backup)_YYYYMMDDTHHMMSSZ_<8 lowercase hex>_<6 lowercase hex>.vpb
```

Upload requirements:

- `Content-Type: application/octet-stream`
- `If-None-Match: *`
- `X-Vibe-Prompt-Protocol: 2`
- `VPBE` as the first four bytes
- no more than 20 MiB, including requests without `Content-Length`

An existing name returns `412 precondition_failed`; it is never overwritten. A successful upload
returns the body ETag in `ETag` and the new control revision in
`X-Vibe-Prompt-Manifest-ETag`. The list schema is `vibe-prompt.snapshots/2`, with `name`, `size`,
`createdAt`, `etag`, and `isHead` for each item. A successful list returns the same strong manifest
revision in both `ETag` and `X-Vibe-Prompt-Manifest-ETag`.

Deletion requires `If-Match` with the quoted ETag returned by the service. A stale ETag returns
`412`. Deleting the snapshot currently referenced by head returns `409 snapshot_is_head`. A
successful deletion preserves the deleted body ETag in `ETag` and returns the final control
revision in `X-Vibe-Prompt-Manifest-ETag`.

### Current head

`GET /v2/head` returns the current pointer and the control manifest ETag:

```json
{
  "schema": "vibe-prompt.head/2",
  "snapshot": "vibe-prompt-auto_20260831T120000Z_0123abcd_456789.vpb",
  "updatedAt": "2026-08-31T12:00:00.000Z"
}
```

Create it with `PUT /v2/head` and `If-None-Match: *`. Update it with the latest `If-Match` ETag.
The ETag identifies the entire manifest revision, so uploading or deleting any snapshot also makes
an older head ETag stale. After uploading a snapshot, use its
`X-Vibe-Prompt-Manifest-ETag` response value for the following head `If-Match`. The request uses
`Content-Type: application/json` and contains the same schema plus `snapshot`; the server supplies
`updatedAt`. The referenced snapshot must already be in the same manifest. A racing or stale write
returns `412`, so clients can refetch instead of silently overwriting another device.
Successful `GET` and `PUT` responses return the same strong control revision in both `ETag` and
`X-Vibe-Prompt-Manifest-ETag`; clients should prefer the dedicated header as their manifest CAS
token.

Each upload gets a unique immutable generation body key before manifest registration. If CAS loses
a race, the unregistered generation stays invisible to list, head, and download and bounded orphan
GC eventually reclaims it. Deletion first removes a non-head member through manifest CAS and then
cleans that exact generation. Cleanup uses a fixed per-request budget and resumes on later requests.
The filename can be reused after deletion because stale GC only knows the old generation key and
cannot delete a replacement generation.

## Development

```sh
npm start
npm test
npm run typecheck
npm run build
```

`npm run build` performs a Wrangler dry-run and does not deploy.

## Security

Snapshots must be encrypted by the client. The Worker checks the `VPBE` magic bytes but cannot
verify the encrypted contents. Never publish `AUTH_VALUE`, decrypted backups, client vault
passwords, or Cloudflare API tokens. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
