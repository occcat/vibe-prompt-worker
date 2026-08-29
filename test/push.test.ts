import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { VaultObject } from "../src/index";
import { RATE_LIMIT_META_KEY } from "../src/rate-limit";
import {
  fetchConfigured,
  getIndex,
  getObject,
  HEALTH_URL,
  objectUrl,
  paddedUuid,
  PROMPT_ID,
  PROMPT_ID_2,
  PUSH_URL,
  pushItem,
  pushObjects,
  putVault,
  tombstoneUrl,
  vaultDocument,
  vpbeBody,
  writeHeaders,
  type ErrorBody,
  type IndexBody,
  type PushResponse,
} from "./helpers";

const LIVE_URL = objectUrl("prompts", PROMPT_ID);
const LIVE_URL_2 = objectUrl("prompts", PROMPT_ID_2);
const TOMBSTONE_URL = tombstoneUrl("prompt", PROMPT_ID);

function tombstoneBytes(id = PROMPT_ID, targetKind = "prompt"): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: "vibe-prompt.tombstone/1",
      targetKind,
      id,
      deletedAt: "2026-08-29T00:00:00.000Z",
    }),
  );
}

function itemsForPrompt(index: IndexBody): IndexBody["items"] {
  const tombstoneId = `prompt:${PROMPT_ID}`;
  return index.items.filter((item) => item.id === PROMPT_ID || item.id === tombstoneId);
}

describe("POST /v1/sync/push", () => {
  beforeEach(async () => {
    expect((await putVault(vaultDocument())).status).toBe(201);
  });

  it("pushes two new VPBE prompts with If-None-Match *", async () => {
    const firstBody = vpbeBody(0x11);
    const secondBody = vpbeBody(0x22);
    const response = await pushObjects([
      pushItem("prompt", PROMPT_ID, firstBody),
      pushItem("prompt", PROMPT_ID_2, secondBody),
    ]);
    expect(response.status).toBe(200);
    const body = await response.json() as PushResponse;
    expect(body.revision).toBe(3);
    expect(body.results).toEqual([
      { id: PROMPT_ID, status: 204, etag: '"2"' },
      { id: PROMPT_ID_2, status: 204, etag: '"3"' },
    ]);

    const gotFirst = await getObject(LIVE_URL);
    expect(gotFirst.status).toBe(200);
    expect(new Uint8Array(await gotFirst.arrayBuffer())).toEqual(firstBody);
    const gotSecond = await getObject(LIVE_URL_2);
    expect(gotSecond.status).toBe(200);
    expect(new Uint8Array(await gotSecond.arrayBuffer())).toEqual(secondBody);
  });

  it("returns 409 for a stale If-Match without rolling back the prior item", async () => {
    const created = await pushObjects([pushItem("prompt", PROMPT_ID, vpbeBody())]);
    expect(created.status).toBe(200);
    const createdBody = await created.json() as PushResponse;
    expect(createdBody.results[0]?.status).toBe(204);
    expect(createdBody.results[0]?.etag).toBe('"2"');

    const response = await pushObjects([
      pushItem("prompt", PROMPT_ID_2, vpbeBody(0x33)),
      pushItem("prompt", PROMPT_ID, vpbeBody(0x44), { ifMatch: '"1"' }),
    ]);
    expect(response.status).toBe(200);
    const body = await response.json() as PushResponse;
    expect(body.revision).toBe(3);
    expect(body.results).toEqual([
      { id: PROMPT_ID_2, status: 204, etag: '"3"' },
      { id: PROMPT_ID, status: 409, currentEtag: '"2"' },
    ]);

    const original = await getObject(LIVE_URL);
    expect(original.status).toBe(200);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(vpbeBody());
    const createdSecond = await getObject(LIVE_URL_2);
    expect(createdSecond.status).toBe(200);
    expect(new Uint8Array(await createdSecond.arrayBuffer())).toEqual(vpbeBody(0x33));
  });

  it("rejects 101 items with 413 and writes nothing", async () => {
    const items = [];
    for (let i = 1; i <= 101; i++) {
      items.push(pushItem("prompt", paddedUuid(i), vpbeBody()));
    }
    const response = await pushObjects(items);
    expect(response.status).toBe(413);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("payload_too_large");

    const index = await (await getIndex()).json() as IndexBody;
    expect(index.items).toEqual([]);
    expect(index.revision).toBe(1);
  });

  it("returns 429 for the 601st object within a minute", async () => {
    const stub = env.VAULT.get(env.VAULT.idFromName("vault"));
    await runInDurableObject(stub, async (instance, state) => {
      expect(instance).toBeInstanceOf(VaultObject);
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)",
        RATE_LIMIT_META_KEY,
        JSON.stringify({ events: [{ at: Date.now(), n: 600 }] }),
      );
    });

    const response = await pushObjects([pushItem("prompt", PROMPT_ID, vpbeBody())]);
    expect(response.status).toBe(429);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("rate_limited");
    expect((await getObject(LIVE_URL)).status).toBe(404);
  });

  it("applies live/tombstone mutex inside a batch; last item wins", async () => {
    const liveBody = vpbeBody(0xcd);
    const response = await pushObjects([
      pushItem("tombstone", `prompt:${PROMPT_ID}`, tombstoneBytes()),
      pushItem("prompt", PROMPT_ID, liveBody),
    ]);
    expect(response.status).toBe(200);
    const body = await response.json() as PushResponse;
    expect(body.results[0]?.status).toBe(204);
    expect(body.results[1]?.status).toBe(204);

    expect((await getObject(TOMBSTONE_URL)).status).toBe(404);
    const live = await getObject(LIVE_URL);
    expect(live.status).toBe(200);
    expect(new Uint8Array(await live.arrayBuffer())).toEqual(liveBody);

    const items = itemsForPrompt(await (await getIndex()).json() as IndexBody);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("prompt");
    expect(items[0]?.id).toBe(PROMPT_ID);
    expect(items[0]?.deleted).toBe(false);
  });
});

describe("GET /v1/health after batch-push", () => {
  it("advertises batch-push and still omits bare batch", async () => {
    const response = await fetchConfigured(HEALTH_URL);
    expect(response.status).toBe(200);
    const body = await response.json() as { capabilities: string[] };
    expect(body.capabilities).toContain("batch-push");
    expect(body.capabilities).not.toContain("batch");
  });
});

describe("POST /v1/sync/push edge Content-Length", () => {
  it("returns 413 when Content-Length is 29360129 without parsing the body", async () => {
    const response = await fetchConfigured(PUSH_URL, {
      method: "POST",
      headers: await writeHeaders({
        "content-type": "application/json",
        "Content-Length": "29360129",
      }),
      body: JSON.stringify({ items: [] }),
    });
    expect(response.status).toBe(413);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("payload_too_large");
  });
});
