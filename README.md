# vibe-prompt-worker

English | [简体中文](README.zh-CN.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/occcat/vibe-prompt-worker)

Self-hosted [Cloudflare Worker](https://developers.cloudflare.com/workers/) for a **vibe-prompt** remote vault. Incremental ciphertext lives in one Durable Object (SQLite). Snapshots live in R2. The Worker never decrypts content.

One deployment is one vault. A second vault needs a second Worker and a different R2 `bucket_name` or Cloudflare account.

## AUTH_VALUE vs vaultPassword

| Name | Stored | Purpose |
| --- | --- | --- |
| `AUTH_VALUE` | Worker **runtime Secret** | Sync password the client uses to reach this Worker. It is **not** a Cloudflare API Token. |
| `vaultPassword` | Client only | Content password. The app encrypts objects as `VPBE` before upload. The Worker never receives this password and never decrypts. |

Do not reuse `AUTH_VALUE` as `vaultPassword`, and do not paste a Cloudflare API Token into either field.

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

These limits matter for a single-vault Worker. Row size is a hard platform cap on both plans.

| Limit | Workers Free | Workers Paid |
| --- | --- | --- |
| Durable Object SQLite per object | 1 GB | 10 GB |
| SQL row / BLOB | **2 MB** | **2 MB** |
| Worker CPU time per request | 10 ms | Paid plan CPU limits |
| Snapshots | R2 bucket `vibe-prompt-snapshots` | Same binding, paid R2 rates after the free tier |

Encrypted objects are capped well below 2 MB. Snapshots go to R2 so they are not stored as SQLite BLOBs.

**Second vault:** do not point two deployments at the same R2 bucket. Change `r2_buckets[0].bucket_name` in `wrangler.jsonc` or use another account.

## What this Worker exposes today

| Request | Auth | Result |
| --- | --- | --- |
| `GET /` | None | `text/plain` body `vibe-prompt-worker` |
| `GET /v1/health` | None (before AUTH) | JSON health; `authConfigured` follows whether `AUTH_VALUE` is set |
| `OPTIONS /v1/share*` | None | `204` |
| Other methods on `/v1/share` and `/v1/share/{token}` | None (no Durable Object) | `404` JSON `not_found` |
| Any other route without `AUTH_VALUE` | — | `503` JSON `misconfigured` / `Must set AUTH_VALUE environment.` |

`/v1/share*` is reserved. v1 does not implement read-only sharing.

Health `capabilities` currently include `etag`, `if-match`, `index-atomic`, and `batch-push`. It does not advertise a bare `batch` capability.

## License

[MIT](LICENSE) © 2026 occcat
