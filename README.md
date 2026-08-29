# vibe-prompt-worker

English | [简体中文](README.zh-CN.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/occcat/vibe-prompt-worker)

Self-hosted [Cloudflare Worker](https://developers.cloudflare.com/workers/) for a **vibe-prompt** remote vault. Incremental ciphertext lives in one Durable Object (SQLite). Snapshots live in R2. The Worker never decrypts content.

One deployment is one vault. A second vault needs a second Worker and a different R2 `bucket_name` or Cloudflare account. Snapshot objects in R2 use keys `{vaultId}/{filename}`.

## AUTH_VALUE vs vaultPassword

| Name | Stored | Purpose |
| --- | --- | --- |
| `AUTH_VALUE` | Worker **runtime Secret** | Sync password the client uses to reach this Worker. It is **not** a Cloudflare API Token, and it is **not** `CLOUDFLARE_API_TOKEN`. |
| `vaultPassword` | Client only | Content password. The app encrypts remote objects and snapshots as `VPBE` before upload. The Worker never receives this password and never decrypts. |

Do not reuse `AUTH_VALUE` as `vaultPassword`, and do not paste a Cloudflare API Token into either field.

Clients send `Authorization: Bearer` where the token is the lowercase hex of
`SHA-256(UTF-8(AUTH_VALUE) || UTF-8("vibe-prompt-worker-v1"))`.
Writes also send `X-Vibe-Prompt-Protocol: 1`.

## Encryption

The Worker only checks the first four bytes (magic). It never decrypts.

| Artifact | Default | Password | Magic | Who enforces |
| --- | --- | --- | --- | --- |
| Local auto backup (in the apps) | Unencrypted | none | `VPBP` | Apps only; this Worker is not involved |
| Remote incremental objects | Encrypted | `vaultPassword` + vault `kdfSalt` | `VPBE` | Worker rejects non-`VPBE` when `encryption=required` |
| Remote snapshots | Encrypted | `vaultPassword` (per-file random salt) | `VPBE` | Worker rejects non-`VPBE` when `encryption=required` |
| Tombstone JSON | Metadata only | — | none | Plain JSON; no template body |

Default vault `encryption` is `required`. Local automatic backups stay `VPBP` and are not stored by this Worker.

## Nextcloud / WebDAV

This Worker is the recommended multi-device backend. Nextcloud / WebDAV is a **client** backend you configure in the vibe-prompt apps, not in this repository. This Worker does not speak WebDAV and is not a Nextcloud app.

## Deploy to Cloudflare

1. Click the button above and sign in to Cloudflare.
2. Authorize GitHub, then confirm the repository copy and Worker name (`vibe-prompt-worker`).
3. Set `AUTH_VALUE` to a long, random string. The Deploy button reads the binding description from `package.json`.
4. Wait for Workers Builds. Wrangler provisions the `VaultObject` Durable Object and the `vibe-prompt-snapshots` R2 bucket from `wrangler.jsonc`.
5. Copy the `https://<worker>.<subdomain>.workers.dev` URL.
6. Open `GET /v1/health`. `"authConfigured"` should be `true`.

If health shows `"authConfigured": false`, add a **runtime** Secret named `AUTH_VALUE` under Worker Settings → Variables and Secrets, then redeploy. Build-time variables are not visible to the running Worker.

See [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

## Self-host from the command line

Requires [Node.js 22](https://nodejs.org/) or newer and a Cloudflare account.

```sh
git clone https://github.com/occcat/vibe-prompt-worker.git
cd vibe-prompt-worker
npm ci
npx wrangler login
npm run deploy
npm run secret
```

`npm run secret` runs `wrangler secret put AUTH_VALUE` and does not write the value into the repository.

For local development:

```sh
cp .dev.vars.example .dev.vars
# Set AUTH_VALUE in .dev.vars. Do not commit that file.
npm start
```

`.dev.vars` is gitignored. `.dev.vars.example` is an empty placeholder.

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

**Second vault:** change `r2_buckets[0].bucket_name` in `wrangler.jsonc` or use another Cloudflare account. Do not point two deployments at the same bucket. R2 keys are already prefixed with `vaultId` (`{vaultId}/{filename}`), but bucket names must still be unique per account.

## HTTP API

`/v1/share*` is reserved. v1 returns **404** `not_found` (except `OPTIONS` → 204). Read-only sharing is not implemented. Those routes do not check `AUTH_VALUE` and do not enter the Durable Object.

Health `capabilities` are `etag`, `if-match`, `index-atomic`, and `batch-push`. The Worker does **not** advertise a bare `batch` capability.

`POST /v1/sync/push` is limited to **600 objects/min** (object count, not HTTP requests; no burst). Over the limit the whole batch returns 429 `rate_limited`. There is no 60 writes/min cap.

### Unauthenticated

| Request | Result |
| --- | --- |
| `GET /` | `text/plain` body `vibe-prompt-worker` |
| `GET /v1/health` | JSON health; `authConfigured` follows whether `AUTH_VALUE` is set |
| `OPTIONS` (any path) | `204` |
| Other methods on `/v1/share` and `/v1/share/{token}` | `404` JSON `not_found` |
| Any other route without `AUTH_VALUE` | `503` JSON `misconfigured` / `Must set AUTH_VALUE environment.` |

### Authenticated (Bearer required)

Writes (`PUT` / `POST` / `DELETE`) need `X-Vibe-Prompt-Protocol: 1` and `If-Match` or `If-None-Match`.

| Request | Result |
| --- | --- |
| `GET` / `PUT /v1/vault` | Vault JSON (`vibe-prompt.vault/1`) |
| `GET /v1/index` | Index JSON; optional `?sinceRevision=` |
| `GET` / `PUT` / `DELETE /v1/objects/prompts/{uuid}` | Live VPBE prompt |
| `GET` / `PUT` / `DELETE /v1/objects/labels/{uuid}` | Live VPBE label |
| `GET` / `PUT` / `DELETE /v1/objects/scopes/{id}` | Live VPBE scope |
| `GET` / `PUT` / `DELETE /v1/objects/tombstones/{kind}:{id}` | Tombstone JSON |
| `GET /v1/snapshots` | Snapshot list |
| `GET` / `PUT` / `DELETE /v1/snapshots/{filename}` | Snapshot body in R2 (does not bump `objectRevision`) |
| `POST /v1/sync/push` | Batch object PUT; partial 409 is valid |

Missing `AUTH_VALUE` on these routes is 503, not 401.

### Not in v1

- `PUT /v1/index` → 405 (`putIndex` is WebDAV-only in the apps)
- `POST /v1/sync/pull` → 404
- Read-only sharing under `/v1/share*` → 404
- Identity-preserving restore

Live object PUT is rejected at **1,500,000** bytes (413). Snapshot PUT at **20 MiB**. Batch push at **28 MiB** `Content-Length`, **100** items, or **20 MiB** decoded. Index over 8000 items or 4 MiB → 507. Missing R2 binding → snapshot routes 503; incremental objects still work.

## CI

GitHub Actions runs `npm ci`, `npm test`, and `npx tsc --noEmit` on pull requests and on pushes to `main` and `thoxvi/**` (Node 22). `npx wrangler deploy` runs only when both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets are set. If either is absent, deploy is skipped and the job still succeeds. Those secrets are Cloudflare credentials for Wrangler, **not** `AUTH_VALUE`.

## License

[MIT](LICENSE) © 2026 occcat
