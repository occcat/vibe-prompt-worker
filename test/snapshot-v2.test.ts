import { describe, expect, it } from "vitest";

import {
  authHeaders,
  configuredEnv,
  deleteV2Snapshot,
  fetchConfigured,
  fetchWithEnv,
  getV2Head,
  getV2Snapshot,
  listV2Snapshots,
  putV2Head,
  putV2Snapshot,
  snapshotFilename,
  V2_HEALTH_URL,
  V2_HEAD_URL,
  V2_SNAPSHOTS_URL,
  v2SnapshotUrl,
  v2WriteHeaders,
  vpbeBody,
  vpbpBody,
  type ErrorBody,
  type V2SnapshotListBody,
} from "./helpers";

const FIRST = snapshotFilename("auto", 1);
const SECOND = snapshotFilename("backup", 2);

describe("snapshot-only v2 health and auth", () => {
  it("exposes unauthenticated R2-only capabilities", async () => {
    const response = await fetchConfigured(V2_HEALTH_URL);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema: "vibe-prompt.health/2",
      name: "vibe-prompt-worker",
      protocolVersion: 2,
      backend: "r2-snapshot",
      capabilities: ["snapshot-head", "snapshot-history", "etag", "if-match"],
      authConfigured: true,
    });
  });

  it("requires the existing derived Bearer token", async () => {
    expect((await fetchConfigured(V2_SNAPSHOTS_URL)).status).toBe(401);
    expect((await fetchConfigured(V2_SNAPSHOTS_URL, {
      headers: { Authorization: "Bearer wrong" },
    })).status).toBe(403);
    expect((await listV2Snapshots()).status).toBe(200);
  });

  it("requires protocol 2 on writes and rejects protocol 1", async () => {
    const missing = await fetchConfigured(v2SnapshotUrl(FIRST), {
      method: "PUT",
      headers: await authHeaders({
        "Content-Type": "application/octet-stream",
        "If-None-Match": "*",
      }),
      body: vpbeBody(),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json() as ErrorBody).error.code).toBe("invalid_protocol");

    const wrong = await fetchConfigured(v2SnapshotUrl(FIRST), {
      method: "PUT",
      headers: await authHeaders({
        "Content-Type": "application/octet-stream",
        "If-None-Match": "*",
        "X-Vibe-Prompt-Protocol": "1",
      }),
      body: vpbeBody(),
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json() as ErrorBody).error.message).toContain("must be 2");
  });
});

describe("snapshot-only v2 immutable snapshots", () => {
  it("uploads, downloads, and lists encrypted VPBE snapshots newest first", async () => {
    const firstPayload = vpbeBody(0x11);
    const secondPayload = vpbeBody(0x22);
    const first = await putV2Snapshot(FIRST, firstPayload);
    const second = await putV2Snapshot(SECOND, secondPayload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.headers.get("ETag")).toMatch(/^".+"$/);

    const downloaded = await getV2Snapshot(FIRST);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("ETag")).toBe(first.headers.get("ETag"));
    expect(downloaded.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(firstPayload);

    const listed = await (await listV2Snapshots()).json() as V2SnapshotListBody;
    expect(listed.schema).toBe("vibe-prompt.snapshots/2");
    expect(listed.items.map((item) => item.name)).toEqual([SECOND, FIRST]);
    expect(listed.items.every((item) => !item.isHead)).toBe(true);
    expect(listed.items[0]?.size).toBe(secondPayload.byteLength);
    expect(Date.parse(listed.items[0]?.createdAt ?? "")).not.toBeNaN();
  });

  it("prevents overwriting an immutable name with If-None-Match:*", async () => {
    expect((await putV2Snapshot(FIRST, vpbeBody(0x11))).status).toBe(201);
    const duplicate = await putV2Snapshot(FIRST, vpbeBody(0x22));
    expect(duplicate.status).toBe(412);
    expect((await duplicate.json() as ErrorBody).error.code).toBe("precondition_failed");
    expect(new Uint8Array(await (await getV2Snapshot(FIRST)).arrayBuffer()))
      .toEqual(vpbeBody(0x11));
  });

  it("rejects missing/wrong preconditions, content type, magic, and filename", async () => {
    const missingPrecondition = await fetchConfigured(v2SnapshotUrl(FIRST), {
      method: "PUT",
      headers: await v2WriteHeaders({ "Content-Type": "application/octet-stream" }),
      body: vpbeBody(),
    });
    expect(missingPrecondition.status).toBe(428);

    const wrongType = await fetchConfigured(v2SnapshotUrl(FIRST), {
      method: "PUT",
      headers: await v2WriteHeaders({
        "Content-Type": "application/json",
        "If-None-Match": "*",
      }),
      body: vpbeBody(),
    });
    expect(wrongType.status).toBe(415);

    const wrongMagic = await putV2Snapshot(FIRST, vpbpBody());
    expect(wrongMagic.status).toBe(400);
    expect((await wrongMagic.json() as ErrorBody).error.code).toBe("invalid_magic");

    const badName = await putV2Snapshot("backup.vpb", vpbeBody());
    expect(badName.status).toBe(400);
    expect((await badName.json() as ErrorBody).error.code).toBe("invalid_path");
  });

  it("rejects declared and streaming bodies over 20 MiB", async () => {
    const declared = await fetchConfigured(v2SnapshotUrl(FIRST), {
      method: "PUT",
      headers: await v2WriteHeaders({
        "Content-Type": "application/octet-stream",
        "Content-Length": String(20 * 1024 * 1024 + 1),
        "If-None-Match": "*",
      }),
      body: vpbeBody(),
    });
    expect(declared.status).toBe(413);

    const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
    oversized.set(vpbeBody());
    const streamed = await fetchConfigured(v2SnapshotUrl(SECOND), {
      method: "PUT",
      headers: await v2WriteHeaders({
        "Content-Type": "application/octet-stream",
        "If-None-Match": "*",
      }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(oversized);
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(413);
  });
});

describe("snapshot-only v2 current head", () => {
  it("creates head once, updates with ETag, and marks the listed snapshot", async () => {
    expect((await getV2Head()).status).toBe(404);
    expect((await putV2Snapshot(FIRST, vpbeBody())).status).toBe(201);
    expect((await putV2Snapshot(SECOND, vpbeBody(0x22))).status).toBe(201);

    const created = await putV2Head(FIRST, { "If-None-Match": "*" });
    expect(created.status).toBe(201);
    const firstEtag = created.headers.get("ETag");
    expect(firstEtag).toBeTruthy();
    expect(await created.json()).toMatchObject({
      schema: "vibe-prompt.head/2",
      snapshot: FIRST,
    });

    const got = await getV2Head();
    expect(got.headers.get("ETag")).toBe(firstEtag);
    expect(await got.json()).toMatchObject({ snapshot: FIRST });

    const updated = await putV2Head(SECOND, { "If-Match": firstEtag! });
    expect(updated.status).toBe(200);
    expect(updated.headers.get("ETag")).not.toBe(firstEtag);
    const list = await (await listV2Snapshots()).json() as V2SnapshotListBody;
    expect(list.items.find((item) => item.name === SECOND)?.isHead).toBe(true);
    expect(list.items.find((item) => item.name === FIRST)?.isHead).toBe(false);
  });

  it("returns 412 for stale create/update and 404 for missing snapshot", async () => {
    expect((await putV2Snapshot(FIRST, vpbeBody())).status).toBe(201);
    const created = await putV2Head(FIRST, { "If-None-Match": "*" });
    expect(created.status).toBe(201);

    expect((await putV2Head(FIRST, { "If-None-Match": "*" })).status).toBe(412);
    expect((await putV2Head(FIRST, { "If-Match": '"stale"' })).status).toBe(412);
    const missing = await putV2Head(SECOND, {
      "If-Match": created.headers.get("ETag")!,
    });
    expect(missing.status).toBe(404);
    expect((await missing.json() as ErrorBody).error.code).toBe("snapshot_not_found");
  });

  it("requires JSON and a supported head document", async () => {
    const wrongType = await fetchConfigured(V2_HEAD_URL, {
      method: "PUT",
      headers: await v2WriteHeaders({
        "Content-Type": "text/plain",
        "If-None-Match": "*",
      }),
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const invalid = await fetchConfigured(V2_HEAD_URL, {
      method: "PUT",
      headers: await v2WriteHeaders({
        "Content-Type": "application/json",
        "If-None-Match": "*",
      }),
      body: JSON.stringify({ schema: "vibe-prompt.head/1", snapshot: FIRST }),
    });
    expect(invalid.status).toBe(400);
  });

  it("rejects deleting current head and allows deleting non-head with matching ETag", async () => {
    const first = await putV2Snapshot(FIRST, vpbeBody());
    const second = await putV2Snapshot(SECOND, vpbeBody(0x22));
    expect((await putV2Head(FIRST, { "If-None-Match": "*" })).status).toBe(201);

    const current = await deleteV2Snapshot(FIRST, first.headers.get("ETag")!);
    expect(current.status).toBe(409);
    expect((await current.json() as ErrorBody).error.code).toBe("snapshot_is_head");

    expect((await deleteV2Snapshot(SECOND)).status).toBe(428);
    expect((await deleteV2Snapshot(SECOND, '"stale"')).status).toBe(412);
    const deleted = await deleteV2Snapshot(SECOND, second.headers.get("ETag")!);
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("ETag")).toBe(second.headers.get("ETag"));
    expect((await getV2Snapshot(SECOND)).status).toBe(404);
  });
});

describe("snapshot-only v2 R2 failures", () => {
  it("maps missing binding to misconfigured", async () => {
    const response = await fetchWithEnv(
      { ...configuredEnv(), SNAPSHOTS: undefined } as unknown as Env,
      V2_SNAPSHOTS_URL,
      { headers: await authHeaders() },
    );
    expect(response.status).toBe(503);
    expect((await response.json() as ErrorBody).error.code).toBe("misconfigured");
  });

  it("maps R2 exceptions to storage_unavailable", async () => {
    const failingBucket = new Proxy({} as R2Bucket, {
      get() {
        return () => Promise.reject(new Error("R2 unavailable"));
      },
    });
    const response = await fetchWithEnv(
      { ...configuredEnv(), SNAPSHOTS: failingBucket } as Env,
      V2_SNAPSHOTS_URL,
      { headers: await authHeaders() },
    );
    expect(response.status).toBe(503);
    expect((await response.json() as ErrorBody).error.code).toBe("storage_unavailable");
  });
});
