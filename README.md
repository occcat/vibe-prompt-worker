<div align="center">

# vibe-prompt-worker

**Cloudflare Worker for a self-hosted vibe-prompt remote vault.**

<p>
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/occcat/vibe-prompt-worker"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" /></a>
</p>

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DA639?style=for-the-badge" alt="License MIT" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js 22+" /></a>
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" /></a>
</p>

English | [简体中文](README.zh-CN.md)

</div>

vibe-prompt-worker is a [Cloudflare Worker](https://developers.cloudflare.com/workers/) you deploy for your own vibe-prompt vault. Incremental ciphertext lives in one Durable Object (SQLite). Snapshots live in R2.

One deployment is one vault. A second vault needs a second Worker and a different R2 `bucket_name` or Cloudflare account.

## Quick Start

### 1. Deploy

**1.1 Deploy to Cloudflare**

1. Click **Deploy to Cloudflare** above and sign in.
2. Authorize GitHub, then confirm the repository copy and Worker name (`vibe-prompt-worker`).
3. Set `AUTH_VALUE` to a long, random string. The Deploy button reads the binding description from `package.json`.
4. Wait for Workers Builds. Wrangler provisions the `VaultObject` Durable Object and the `vibe-prompt-snapshots` R2 bucket from `wrangler.jsonc`.
5. Copy the `https://<worker>.<subdomain>.workers.dev` URL.

See [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

**1.2 Deploy from the command line**

Requires [Node.js 22](https://nodejs.org/) or newer and a Cloudflare account.

```sh
git clone https://github.com/occcat/vibe-prompt-worker.git
cd vibe-prompt-worker
npm ci
npx wrangler login
npm run deploy
npm run secret
```

`npm run secret` runs `wrangler secret put AUTH_VALUE`. It does not write the value into the repository.

**1.3 Run locally**

```sh
cp .dev.vars.example .dev.vars
# Set AUTH_VALUE in .dev.vars. Do not commit that file.
npm start
```

`.dev.vars` is gitignored. `.dev.vars.example` is an empty placeholder.

### 2. Confirm health

Open `GET /v1/health`. `"authConfigured"` should be `true`.

If it is `false`, add a **runtime** Secret named `AUTH_VALUE` under Worker Settings → Variables and Secrets, then redeploy. Build-time variables are not visible to the running Worker.

### 3. Connect vibe-prompt

Paste the Worker URL into the vibe-prompt app as the remote vault. Use the same `AUTH_VALUE` as the sync password. Keep `vaultPassword` in the app only.

See [SECURITY.md](SECURITY.md) for what must not appear in issues, pull requests, or chat.

## AUTH_VALUE vs vaultPassword

| Name | Stored | Purpose |
| --- | --- | --- |
| `AUTH_VALUE` | Worker **runtime Secret** | Sync password the client uses to reach this Worker. It is **not** a Cloudflare API Token, and it is **not** `CLOUDFLARE_API_TOKEN`. |
| `vaultPassword` | Client only | Content password. The app encrypts remote objects and snapshots before upload. |

Clients send `Authorization: Bearer` where the token is the lowercase hex of
`SHA-256(UTF-8(AUTH_VALUE) || UTF-8("vibe-prompt-worker-v1"))`.
Writes send `X-Vibe-Prompt-Protocol: 1`.

## Encryption

When vault `encryption` is `required`, the Worker checks that live objects and snapshots start with the four-byte `VPBE` magic. `optional` and `forbidden` skip that check. If the vault document is missing, a live object PUT treats encryption as `required`.

Vault JSON (`vibe-prompt.vault/1`) must set `snapshotRetention.maxCount` to `30` and `maxBytes` to `629145600`. `encryption` is `required`, `optional`, or `forbidden`. `vaultId` and `kdfSalt` cannot change after create.

Tombstones are JSON (`vibe-prompt.tombstone/1`), not `VPBE`.

Snapshot objects in R2 use keys `{vaultId}/{filename}`. Do not point two deployments at the same bucket. Change `r2_buckets[0].bucket_name` in `wrangler.jsonc` or use another Cloudflare account.

## Free vs Paid

These limits matter for a single-vault Worker. Row size is a hard platform cap on **both** plans.

| Limit | Workers Free | Workers Paid |
| --- | --- | --- |
| Durable Object SQLite per object | 1 GB | 10 GB |
| SQL row / BLOB | **2 MB** | **2 MB** |
| Worker CPU time per request | 10 ms | Paid plan CPU limits |
| Snapshots | R2 bucket `vibe-prompt-snapshots` | Same binding; R2 bills usage beyond the free tier |

Encrypted objects are capped at 1,500,000 bytes, well below the 2 MB row limit. Snapshots go to R2 so they are not stored as SQLite BLOBs.

**R2 billing:** this Worker does not disable R2 charges. After the [R2 free tier](https://developers.cloudflare.com/r2/pricing/) you pay Cloudflare's published rates.

## HTTP API

All responses include `Access-Control-Allow-Origin: *`.

Health JSON uses schema `vibe-prompt.health/1`. `capabilities` are `etag`, `if-match`, `index-atomic`, and `batch-push` (not `batch`). `authConfigured` follows whether `AUTH_VALUE` is set.

A missing `X-Vibe-Prompt-Protocol` header is 400 `invalid_protocol` only for `PUT` / `POST` / `DELETE` / `PATCH`. If the header is present and not `1`, GET also returns 400.

Unset `AUTH_VALUE` on vault routes is 503 `misconfigured` (`Must set AUTH_VALUE environment.`). Missing `Authorization: Bearer` is 401 `unauthorized` (`Missing Authorization bearer token.`). Invalid Bearer is 403 `forbidden` (`Sorry, you have supplied an invalid key.`).

PUT on vault, objects, and snapshots requires `If-Match` or `If-None-Match` (428 `precondition_required` if neither). DELETE requires `If-Match` only. `POST /v1/sync/push` does not require those headers on the POST; each item carries `ifMatch` / `ifNoneMatch`.

Snapshot filenames must match `vibe-prompt-(auto|backup)_YYYYMMDDTHHMMSSZ_<8hex>_<6hex>.vpb` or the request is 400 `invalid_path`. Putting the 31st `auto_` snapshot GCs the oldest `auto_` so 30 autos remain; `backup_` snapshots are kept.

`POST /v1/sync/push` is limited to **600 objects/min** (object count, not HTTP requests; no burst). Over the limit the whole batch returns 429 `rate_limited`. Single PUT/DELETE is not rate-limited.

Live object PUT is 413 `payload_too_large` at **1,500,000** bytes. Snapshot PUT is 413 at **20 MiB** Worker-edge `Content-Length` only. Batch push is 413 at **28 MiB** `Content-Length`, **100** items, or **20 MiB** decoded. Index over 8000 items or 4 MiB canonical JSON is 507 `index_too_large`. Missing R2 binding makes snapshot routes 503; incremental objects still work.

### Unauthenticated

| Request | Result |
| --- | --- |
| `GET /` | `text/plain` body `vibe-prompt-worker` |
| `GET /v1/health` | JSON health; `authConfigured` follows whether `AUTH_VALUE` is set |
| `OPTIONS` (any path) | `204` |
| `/v1/share` and `/v1/share/{token}` (except `OPTIONS`) | `404` JSON `not_found` (no `AUTH_VALUE` check, no Durable Object) |
| Any other vault route without `AUTH_VALUE` | `503` JSON `misconfigured` / `Must set AUTH_VALUE environment.` |

### Authenticated (Bearer required)

| Request | Result |
| --- | --- |
| `GET` / `PUT /v1/vault` | Vault JSON (`vibe-prompt.vault/1`) |
| `GET /v1/index` | Index JSON; optional `?sinceRevision=` |
| `PUT /v1/index` | `405` `method_not_allowed` |
| `GET` / `PUT` / `DELETE /v1/objects/prompts/{uuid}` | Live VPBE prompt |
| `GET` / `PUT` / `DELETE /v1/objects/labels/{uuid}` | Live VPBE label |
| `GET` / `PUT` / `DELETE /v1/objects/scopes/{id}` | Live VPBE scope |
| `GET` / `PUT` / `DELETE /v1/objects/tombstones/{kind}:{id}` | Tombstone JSON |
| `GET /v1/snapshots` | Snapshot list |
| `GET` / `PUT` / `DELETE /v1/snapshots/{filename}` | Snapshot body in R2 (does not bump `objectRevision`) |
| `POST /v1/sync/push` | Batch object PUT; partial 409 is valid |
| `POST /v1/sync/pull` | `404` `not_found` after auth |

## Community

- [GitHub Issues](https://github.com/occcat/vibe-prompt-worker/issues), bugs and concrete requests
- [GitHub Discussions](https://github.com/occcat/vibe-prompt-worker/discussions), questions and ideas
- [Contributing](CONTRIBUTING.md), commit and review expectations
- [Security](SECURITY.md), private vulnerability reports

## License

The contents of this repository are released under the [MIT License](LICENSE).
