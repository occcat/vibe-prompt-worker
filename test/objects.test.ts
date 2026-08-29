import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { VaultObject } from "../src/index";
import {
  deleteObject,
  fetchConfigured,
  getIndex,
  getObject,
  objectUrl,
  paddedUuid,
  PROMPT_ID,
  PROMPT_ID_2,
  putObject,
  putVault,
  tombstoneUrl,
  vaultDocument,
  vpbeBody,
  vpbpBody,
  writeHeaders,
  type ErrorBody,
  type IndexBody,
} from "./helpers";

const LIVE_URL = objectUrl("prompts", PROMPT_ID);
const TOMBSTONE_URL = tombstoneUrl("prompt", PROMPT_ID);
const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function tombstoneDocument(
  id = PROMPT_ID,
  targetKind = "prompt",
): Record<string, unknown> {
  return {
    schema: "vibe-prompt.tombstone/1",
    targetKind,
    id,
    deletedAt: "2026-08-29T00:00:00.000Z",
  };
}

function itemsForPrompt(index: IndexBody): IndexBody["items"] {
  const tombstoneId = `prompt:${PROMPT_ID}`;
  return index.items.filter((item) => item.id === PROMPT_ID || item.id === tombstoneId);
}

describe("PUT object payload limit at the edge", () => {
  it("PUT live object with Content-Length 1500001 is 413 without hitting the DO", async () => {
    const response = await fetchConfigured(LIVE_URL, {
      method: "PUT",
      headers: await writeHeaders({
        "If-None-Match": "*",
        "Content-Length": "1500001",
      }),
      body: vpbeBody(),
    });
    expect(response.status).toBe(413);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("payload_too_large");
  });
});

describe("live prompt VPBE objects", () => {
  beforeEach(async () => {
    expect((await putVault(vaultDocument())).status).toBe(201);
  });

  it("PUT VPBE If-None-Match:* stores bytes and indexes kind prompt", async () => {
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
    const items = itemsForPrompt(body);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("prompt");
    expect(items[0]?.id).toBe(PROMPT_ID);
    expect(items[0]?.deleted).toBe(false);
    expect(items[0]?.bytes).toBe(payload.byteLength);
    expect(items[0]?.etag).toBe(created.headers.get("ETag"));
    expect(items[0]?.updatedAt).toMatch(CANONICAL_DATE);
  });

  it("PUT VPBP with encryption=required is 400 invalid_magic", async () => {
    const response = await putObject(LIVE_URL, vpbpBody());
    expect(response.status).toBe(400);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("invalid_magic");
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
    const items = itemsForPrompt(await index.json() as IndexBody);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("tombstone");
    expect(items[0]?.id).toBe(`prompt:${PROMPT_ID}`);
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

    const items = itemsForPrompt(await (await getIndex()).json() as IndexBody);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("prompt");
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

    const items = itemsForPrompt(await (await getIndex()).json() as IndexBody);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("tombstone");
    expect(items[0]?.deleted).toBe(true);
  });

  it("If-Match mismatch is 409 with currentEtag", async () => {
    const created = await putObject(LIVE_URL, vpbeBody());
    expect(created.status).toBe(201);
    expect(created.headers.get("ETag")).toBe('"2"');

    const conflict = await putObject(LIVE_URL, vpbeBody(0x11), { "If-Match": '"1"' });
    expect(conflict.status).toBe(409);
    const body = await conflict.json() as ErrorBody;
    expect(body.error.code).toBe("conflict");
    expect(body.currentEtag).toBe('"2"');
    expect(body.currentRevision).toBe(2);
  });

  it("concurrent PUTs sequentialize and the stale If-Match is 409", async () => {
    const created = await putObject(LIVE_URL, vpbeBody());
    expect(created.status).toBe(201);
    const etag = created.headers.get("ETag");
    expect(etag).toBeTruthy();

    const first = putObject(LIVE_URL, vpbeBody(0x01), { "If-Match": etag! });
    const second = putObject(LIVE_URL, vpbeBody(0x02), { "If-Match": etag! });
    const [a, b] = await Promise.all([first, second]);
    const statuses = [a.status, b.status].sort((left, right) => left - right);
    expect(statuses).toEqual([204, 409]);

    const conflict = a.status === 409 ? a : b;
    const success = a.status === 204 ? a : b;
    const body = await conflict.json() as ErrorBody;
    expect(body.error.code).toBe("conflict");
    expect(body.currentEtag).toBe(success.headers.get("ETag"));
    const revisionHeader = success.headers.get("X-Vibe-Prompt-Revision");
    expect(body.currentRevision).toBe(Number(revisionHeader));
  });
});

describe("index item limit", () => {
  it("PUT of the 8001st object returns 507 after SQL seed of 8000", async () => {
    const stub = env.VAULT.get(env.VAULT.idFromName("vault"));
    const seedBody = vpbeBody();
    await runInDurableObject(stub, async (instance, state) => {
      expect(instance).toBeInstanceOf(VaultObject);
      state.storage.transactionSync(() => {
        for (let i = 1; i <= 8000; i++) {
          const id = paddedUuid(i);
          state.storage.sql.exec(
            `INSERT INTO blobs (path, etag, revision, bytes, updated_at, body)
             VALUES (?, ?, ?, ?, ?, ?)`,
            `objects/prompts/${id}.vpb`,
            `"${i}"`,
            i,
            seedBody.byteLength,
            "2026-01-01T00:00:00.000Z",
            seedBody,
          );
        }
        state.storage.sql.exec(
          "INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)",
          "object_revision",
          "8000",
        );
      });
    });

    const existing = await putObject(
      objectUrl("prompts", paddedUuid(1)),
      vpbeBody(0x22),
      { "If-Match": '"1"' },
    );
    expect(existing.status).toBe(204);

    const overflow = await putObject(
      objectUrl("prompts", paddedUuid(8001)),
      vpbeBody(),
    );
    expect(overflow.status).toBe(507);
    const body = await overflow.json() as ErrorBody;
    expect(body.error.code).toBe("index_too_large");
  }, 30_000);
});

describe("GET /v1/index sinceRevision", () => {
  it("filters items but keeps the global revision", async () => {
    expect((await putVault(vaultDocument())).status).toBe(201);
    expect((await putObject(LIVE_URL, vpbeBody())).status).toBe(201);
    expect((await putObject(objectUrl("prompts", PROMPT_ID_2), vpbeBody(0x33))).status)
      .toBe(201);

    const full = await (await getIndex()).json() as IndexBody;
    expect(full.revision).toBe(3);
    expect(full.items).toHaveLength(2);

    const filtered = await (await getIndex(2)).json() as IndexBody;
    expect(filtered.revision).toBe(3);
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]?.id).toBe(PROMPT_ID_2);
    expect(filtered.items[0]?.revision).toBe(3);
  });
});

describe("object path and delete edges", () => {
  beforeEach(async () => {
    expect((await putVault(vaultDocument())).status).toBe(201);
  });

  it("rejects uppercase uuid paths with 400 invalid_path", async () => {
    const response = await putObject(
      objectUrl("prompts", "11111111-2222-4333-8444-55555555555A"),
      vpbeBody(),
    );
    expect(response.status).toBe(400);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("invalid_path");
  });

  it("PUT without If-Match or If-None-Match is 428", async () => {
    const response = await fetchConfigured(LIVE_URL, {
      method: "PUT",
      headers: await writeHeaders(),
      body: vpbeBody(),
    });
    expect(response.status).toBe(428);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("precondition_required");
  });

  it("DELETE live without If-Match is 428", async () => {
    expect((await putObject(LIVE_URL, vpbeBody())).status).toBe(201);
    const response = await deleteObject(LIVE_URL);
    expect(response.status).toBe(428);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("precondition_required");
  });

  it("DELETE tombstone wipes it without recreating the live object", async () => {
    expect((await putObject(LIVE_URL, vpbeBody())).status).toBe(201);
    const tombstone = await putObject(
      TOMBSTONE_URL,
      JSON.stringify(tombstoneDocument()),
    );
    expect(tombstone.status).toBe(201);
    const etag = tombstone.headers.get("ETag");
    expect(etag).toBeTruthy();

    const deleted = await deleteObject(TOMBSTONE_URL, { "If-Match": etag! });
    expect(deleted.status).toBe(204);
    expect((await getObject(TOMBSTONE_URL)).status).toBe(404);
    expect((await getObject(LIVE_URL)).status).toBe(404);
    expect(itemsForPrompt(await (await getIndex()).json() as IndexBody)).toEqual([]);
  });

  it("PUT scope VPBE is indexed as kind scope", async () => {
    const url = objectUrl("scopes", "inbox.main");
    const created = await putObject(url, vpbeBody());
    expect(created.status).toBe(201);
    const index = await (await getIndex()).json() as IndexBody;
    const item = index.items.find((entry) => entry.id === "inbox.main");
    expect(item?.kind).toBe("scope");
    expect(item?.deleted).toBe(false);
  });
});
