import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

beforeEach(async () => {
  const stub = env.VAULT.get(env.VAULT.idFromName("vault"));
  await runInDurableObject(stub, async (_instance, state) => {
    try {
      state.storage.sql.exec("DELETE FROM blobs");
      state.storage.sql.exec("DELETE FROM meta");
    } catch {
      // Schema is created on the first VaultObject request.
    }
  });
});
