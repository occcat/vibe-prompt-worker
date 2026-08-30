import { beforeEach, describe, expect, it } from "vitest";

import {
  deleteObject,
  getIndex,
  getObject,
  objectUrl,
  putObject,
  putVault,
  tombstoneUrl,
  vaultDocument,
  vpbeBody,
  type IndexBody,
} from "./helpers";

const LABEL_ID = "33333333-4444-4555-8666-777777777777";
const LIVE_URL = objectUrl("labels", LABEL_ID);
const TOMBSTONE_URL = tombstoneUrl("label", LABEL_ID);
const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function tombstoneDocument(
  id = LABEL_ID,
  targetKind = "label",
): Record<string, unknown> {
  return {
    schema: "vibe-prompt.tombstone/1",
    targetKind,
    id,
    deletedAt: "2026-08-29T00:00:00.000Z",
  };
}

function itemsForLabel(index: IndexBody): IndexBody["items"] {
  const tombstoneId = `label:${LABEL_ID}`;
  return index.items.filter((item) => item.id === LABEL_ID || item.id === tombstoneId);
}

describe("live label VPBE objects", () => {
  beforeEach(async () => {
    expect((await putVault(vaultDocument())).status).toBe(201);
  });

  it("PUT VPBE If-None-Match:* stores bytes and indexes kind label", async () => {
    const payload = vpbeBody();
    const created = await putObject(LIVE_URL, payload);
    expect(created.status).toBe(201);
    expect(created.headers.get("ETag")).toMatch(/^"\d+"$/);
    expect(created.headers.get("X-Vibe-Prompt-Revision")).toMatch(/^\d+$/);

    const got = await getObject(LIVE_URL);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toMatch(/^application\/octet-stream\b/);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(payload);

    const index = await getIndex();
    expect(index.status).toBe(200);
    const body = await index.json() as IndexBody;
    expect(body.schema).toBe("vibe-prompt.index/1");
    const items = itemsForLabel(body);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("label");
    expect(items[0]?.id).toBe(LABEL_ID);
    expect(items[0]?.deleted).toBe(false);
    expect(items[0]?.bytes).toBe(payload.byteLength);
    expect(items[0]?.etag).toBe(created.headers.get("ETag"));
    expect(items[0]?.updatedAt).toMatch(CANONICAL_DATE);
  });

  it("PUT tombstone while live exists leaves only the tombstone", async () => {
    expect((await putObject(LIVE_URL, vpbeBody())).status).toBe(201);

    const tombstone = await putObject(
      TOMBSTONE_URL,
      JSON.stringify(tombstoneDocument()),
    );
    expect(tombstone.status).toBe(201);

    const liveGet = await getObject(LIVE_URL);
    expect(liveGet.status).toBe(404);
    const tombstoneGet = await getObject(TOMBSTONE_URL);
    expect(tombstoneGet.status).toBe(200);
    expect(tombstoneGet.headers.get("content-type")).toMatch(/^application\/json\b/);

    const index = await getIndex();
    const items = itemsForLabel(await index.json() as IndexBody);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("tombstone");
    expect(items[0]?.id).toBe(`label:${LABEL_ID}`);
    expect(items[0]?.deleted).toBe(true);
  });

  it("PUT live while tombstone exists leaves only the live object", async () => {
    expect((await putObject(LIVE_URL, vpbeBody())).status).toBe(201);
    expect((await putObject(TOMBSTONE_URL, JSON.stringify(tombstoneDocument()))).status)
      .toBe(201);

    const restored = await putObject(LIVE_URL, vpbeBody(0xcd));
    expect(restored.status).toBe(201);

    expect((await getObject(TOMBSTONE_URL)).status).toBe(404);
    const liveGet = await getObject(LIVE_URL);
    expect(liveGet.status).toBe(200);
    expect(new Uint8Array(await liveGet.arrayBuffer())).toEqual(vpbeBody(0xcd));

    const items = itemsForLabel(await (await getIndex()).json() as IndexBody);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("label");
    expect(items[0]?.deleted).toBe(false);
  });

  it("DELETE live without a prior tombstone auto-inserts a tombstone", async () => {
    const created = await putObject(LIVE_URL, vpbeBody());
    expect(created.status).toBe(201);
    const etag = created.headers.get("ETag");
    expect(etag).toBeTruthy();

    const deleted = await deleteObject(LIVE_URL, { "If-Match": etag! });
    expect(deleted.status).toBe(204);

    expect((await getObject(LIVE_URL)).status).toBe(404);
    expect((await getObject(TOMBSTONE_URL)).status).toBe(200);

    const items = itemsForLabel(await (await getIndex()).json() as IndexBody);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("tombstone");
    expect(items[0]?.deleted).toBe(true);
  });
});
