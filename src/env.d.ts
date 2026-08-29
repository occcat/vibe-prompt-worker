interface Env {
  // Runtime Secret via `wrangler secret put` / `.dev.vars`. Omitted when unset.
  AUTH_VALUE?: string;
}

declare namespace Cloudflare {
  interface Env {
    AUTH_VALUE?: string;
  }
}
