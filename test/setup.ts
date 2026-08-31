import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

beforeEach(async () => {
  let cursor: string | undefined;
  do {
    const listed = await env.SNAPSHOTS.list({ cursor, limit: 1000 });
    if (listed.objects.length > 0) {
      await env.SNAPSHOTS.delete(listed.objects.map((object) => object.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
});
