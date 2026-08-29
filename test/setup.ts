import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

beforeEach(async () => {
  const stub = env.VAULT.get(env.VAULT.idFromName("vault"));
  await runInDurableObject(stub, async (_instance, state) => {
    try {
      state.storage.sql.exec("DELETE FROM blobs");
      state.storage.sql.exec("DELETE FROM meta");
      state.storage.sql.exec("DELETE FROM snapshots");
    } catch {
      // Schema is created on the first VaultObject request.
    }
  });
  try {
    const listed = await env.SNAPSHOTS.list({ limit: 1000 });
    if (listed.objects.length > 0) {
      await env.SNAPSHOTS.delete(listed.objects.map((object) => object.key));
    }
  } catch {
    // SNAPSHOTS is optional when simulating a missing R2 binding.
  }
});
