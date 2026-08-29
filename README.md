<div align="center">

# vibe-prompt-worker

**Self-hosted remote vault for vibe-prompt. The Worker never decrypts.**

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

vibe-prompt-worker is a [Cloudflare Worker](https://developers.cloudflare.com/workers/) you deploy for your own vibe-prompt vault. Incremental ciphertext lives in one Durable Object (SQLite). Snapshots live in R2. The Worker checks magic bytes and never decrypts content.

Nextcloud / WebDAV is a **client** backend you configure in the vibe-prompt apps, not in this repository. This Worker is the recommended multi-device backend. It does not speak WebDAV and is not a Nextcloud app.

One deployment is one vault. A second vault needs a second Worker and a different R2 `bucket_name` or Cloudflare account.

## Quick Start

### 1. Deploy

Pick whichever fits your flow.

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

Never paste `AUTH_VALUE`, `vaultPassword`, Cloudflare API tokens, ciphertext, or a personal Worker URL into issues, pull requests, or chat.

## Highlights

| Feature | What it does |
| --- | --- |
| **The Worker never decrypts** | Remote objects and snapshots are `VPBE` ciphertext. The Worker only checks the first four bytes (magic). `vaultPassword` stays on the device. |
| **One deployment, one vault** | Incremental ciphertext lives in one Durable Object (SQLite). Snapshots go to R2 so they are not stored as SQLite BLOBs. |
| **Native vibe-prompt protocol** | Health advertises `etag`, `if-match`, `index-atomic`, and `batch-push`. Writes require `X-Vibe-Prompt-Protocol: 1` and `If-Match` or `If-None-Match`. |
| **Deploy with a button or Wrangler** | The Cloudflare Deploy button provisions the Worker, Durable Object, and R2 bucket. CLI deploy is `npm run deploy` plus `npm run secret`. |
| **Sync password is not the content password** | `AUTH_VALUE` is a Worker runtime Secret. `vaultPassword` never reaches the Worker. Do not reuse one as the other, and do not paste a Cloudflare API token into either field. |

## vs Nextcloud / WebDAV

Most vibe-prompt setups can store files somewhere. The real questions are whether the backend speaks the native protocol, whether the host ever sees plaintext, and whether you can deploy it without running a file server.

| Capability | vibe-prompt-worker | Nextcloud / WebDAV |
| --- | :---: | :---: |
| Native vibe-prompt protocol (`etag`, `if-match`, `batch-push`) | ✓ | — |
| Host never decrypts content | ✓ | — |
| One-click Cloudflare deploy | ✓ | — |
| Incremental objects in a Durable Object | ✓ | — |
| Snapshots outside the 2 MB SQL row limit | ✓ | files |
| WebDAV | — | ✓ |
| Configured in this repository | ✓ | — (in the apps) |
| Read-only sharing in v1 | — | depends |

Nextcloud / WebDAV remains available in the apps. This Worker does not replace that client backend and does not speak WebDAV.

## AUTH_VALUE vs vaultPassword

| Name | Stored | Purpose |
| --- | --- | --- |
| `AUTH_VALUE` | Worker **runtime Secret** | Sync password the client uses to reach this Worker. It is **not** a Cloudflare API Token, and it is **not** `CLOUDFLARE_API_TOKEN`. |
| `vaultPassword` | Client only | Content password. The app encrypts remote objects and snapshots as `VPBE` before upload. The Worker never receives this password and never decrypts. |

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

GitHub Actions runs `npm ci`, `npm test`, and `npx tsc --noEmit` on pull requests and on pushes to `main` and `thoxvi/**` (Node 22). `npx wrangler deploy` runs only when both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets are set. If either is absent, deploy is skipped and the job still succeeds.

Those secrets are Cloudflare credentials for Wrangler, **not** `AUTH_VALUE`. Do not put their values in this repository, in issues, or in pull requests.

## Community

- [GitHub Issues](https://github.com/occcat/vibe-prompt-worker/issues), bugs and concrete requests
- [GitHub Discussions](https://github.com/occcat/vibe-prompt-worker/discussions), questions and ideas
- [Contributing](CONTRIBUTING.md), commit and review expectations
- [Security](SECURITY.md), private vulnerability reports

## License

The contents of this repository are released under the [MIT License](LICENSE).
