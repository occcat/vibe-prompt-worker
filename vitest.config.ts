import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// `defineWorkersConfig` was removed from @cloudflare/vitest-pool-workers; cloudflareTest is the
// replacement and still loads bindings from wrangler.jsonc.

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
