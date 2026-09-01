import { env } from "cloudflare:workers";
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
const THIRD = snapshotFilename("auto", 3);

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type StoredManifest = {
  snapshots: Array<{ name: string; bodyKey: string }>;
  pendingDeletes: string[];
};

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function expectStrongEtag(value: string | null): void {
  expect(value).toMatch(/^"[^"\r\n]+"$/);
}

function expectV2IntegrityHeaders(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
  expectStrongEtag(response.headers.get("ETag"));
}

function overrideBucket(
  overrides: Partial<Pick<R2Bucket, "delete" | "get" | "list" | "put">>,
): R2Bucket {
  return new Proxy(env.SNAPSHOTS, {
    get(target, property) {
      const override = Reflect.get(overrides, property) as unknown;
      if (override !== undefined) {
        return override;
      }
      const original = Reflect.get(target, property) as unknown;
      return typeof original === "function" ? original.bind(target) : original;
    },
  });
}

function isManifestMutation(
  key: string,
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
  predicate: (manifest: Record<string, unknown>) => boolean,
): boolean {
  if (key !== "manifest.json" || typeof value !== "string") {
    return false;
  }
  return predicate(JSON.parse(value) as Record<string, unknown>);
}

async function storedManifest(): Promise<StoredManifest> {
  const object = await env.SNAPSHOTS.get("manifest.json");
  if (object === null) {
    throw new Error("manifest is missing");
  }
  return object.json() as Promise<StoredManifest>;
}

async function bodyKeyFor(filename: string): Promise<string> {
  const item = (await storedManifest()).snapshots.find((candidate) => {
    return candidate.name === filename;
  });
  if (item === undefined) {
    throw new Error(`missing manifest item: ${filename}`);
  }
  return item.bodyKey;
}

async function putHeadWithBucket(
  bucket: R2Bucket,
  filename: string,
  etag: string,
): Promise<Response> {
  return fetchWithEnv(
    { ...configuredEnv(), SNAPSHOTS: bucket },
    V2_HEAD_URL,
    {
      method: "PUT",
      headers: await v2WriteHeaders({
        "Content-Type": "application/json",
        "If-Match": etag,
      }),
      body: JSON.stringify({ schema: "vibe-prompt.head/2", snapshot: filename }),
    },
  );
}

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
    const missing = await fetchConfigured(V2_SNAPSHOTS_URL);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("Cache-Control")).toBe("no-store, no-transform");
    const invalid = await fetchConfigured(V2_SNAPSHOTS_URL, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(invalid.status).toBe(403);
    expect(invalid.headers.get("Cache-Control")).toBe("no-store, no-transform");
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
    expectV2IntegrityHeaders(first);
    expectStrongEtag(first.headers.get("X-Vibe-Prompt-Manifest-ETag"));

    const downloaded = await fetchConfigured(v2SnapshotUrl(FIRST), {
      headers: await authHeaders({ "Accept-Encoding": "gzip, br" }),
    });
    expect(downloaded.status).toBe(200);
    expectV2IntegrityHeaders(downloaded);
    expect(downloaded.headers.get("ETag")).toBe(first.headers.get("ETag"));
    expect(downloaded.headers.get("X-Vibe-Prompt-Manifest-ETag")).toBeNull();
    expect(downloaded.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(firstPayload);

    const listResponse = await listV2Snapshots();
    expectV2IntegrityHeaders(listResponse);
    expect(listResponse.headers.get("X-Vibe-Prompt-Manifest-ETag"))
      .toBe(listResponse.headers.get("ETag"));
    const listed = await listResponse.json() as V2SnapshotListBody;
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
    expectV2IntegrityHeaders(created);
    expect(created.headers.get("X-Vibe-Prompt-Manifest-ETag")).toBe(firstEtag);
    expect(await created.json()).toMatchObject({
      schema: "vibe-prompt.head/2",
      snapshot: FIRST,
    });

    const got = await getV2Head();
    expectV2IntegrityHeaders(got);
    expect(got.headers.get("ETag")).toBe(firstEtag);
    expect(got.headers.get("X-Vibe-Prompt-Manifest-ETag")).toBe(firstEtag);
    expect(await got.json()).toMatchObject({ snapshot: FIRST });

    const updated = await putV2Head(SECOND, { "If-Match": firstEtag! });
    expect(updated.status).toBe(200);
    expectV2IntegrityHeaders(updated);
    expect(updated.headers.get("X-Vibe-Prompt-Manifest-ETag"))
      .toBe(updated.headers.get("ETag"));
    expect(updated.headers.get("ETag")).not.toBe(firstEtag);
    const list = await (await listV2Snapshots()).json() as V2SnapshotListBody;
    expect(list.items.find((item) => item.name === SECOND)?.isHead).toBe(true);
    expect(list.items.find((item) => item.name === FIRST)?.isHead).toBe(false);
  });

  it("publishes head with the manifest ETag returned by snapshot upload", async () => {
    const first = await putV2Snapshot(FIRST, vpbeBody(0x11));
    const firstManifestEtag = first.headers.get("X-Vibe-Prompt-Manifest-ETag");
    expect(firstManifestEtag).toBeTruthy();
    const initialHead = await putV2Head(FIRST, { "If-None-Match": "*" });
    expect(initialHead.status).toBe(201);

    const second = await putV2Snapshot(SECOND, vpbeBody(0x22));
    const secondManifestEtag = second.headers.get("X-Vibe-Prompt-Manifest-ETag");
    expect(secondManifestEtag).toBeTruthy();
    expect(secondManifestEtag).not.toBe(initialHead.headers.get("ETag"));

    const stale = await putV2Head(SECOND, {
      "If-Match": initialHead.headers.get("ETag")!,
    });
    expect(stale.status).toBe(412);
    const published = await putV2Head(SECOND, { "If-Match": secondManifestEtag! });
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ snapshot: SECOND });
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

  it("requires a create or update precondition", async () => {
    expect((await putV2Snapshot(FIRST, vpbeBody())).status).toBe(201);
    const response = await putV2Head(FIRST);
    expect(response.status).toBe(428);
    expect((await response.json() as ErrorBody).error.code)
      .toBe("precondition_required");
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
    expect(deleted.headers.get("Cache-Control")).toBe("no-store, no-transform");
    expect(deleted.headers.get("ETag")).toBe(second.headers.get("ETag"));
    expectStrongEtag(deleted.headers.get("X-Vibe-Prompt-Manifest-ETag"));
    const afterDelete = await listV2Snapshots();
    expect(deleted.headers.get("X-Vibe-Prompt-Manifest-ETag"))
      .toBe(afterDelete.headers.get("X-Vibe-Prompt-Manifest-ETag"));
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

describe("snapshot-only v2 manifest linearization", () => {
  it("lets head=>B win over a stale DELETE(B) manifest CAS", async () => {
    const first = await putV2Snapshot(FIRST, vpbeBody(0x11));
    const second = await putV2Snapshot(SECOND, vpbeBody(0x22));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const createdHead = await putV2Head(FIRST, { "If-None-Match": "*" });
    const oldManifestEtag = createdHead.headers.get("ETag")!;

    const reachedDeleteCas = deferred();
    const releaseDeleteCas = deferred();
    const put: R2Bucket["put"] = async (key, value, options) => {
      if (isManifestMutation(key, value, (manifest) => {
        const pending = manifest.pendingDeletes as unknown[];
        const snapshots = manifest.snapshots as Array<Record<string, unknown>>;
        return pending.length > 0 && !snapshots.some((item) => item.name === SECOND);
      })) {
        reachedDeleteCas.resolve();
        await releaseDeleteCas.promise;
      }
      return env.SNAPSHOTS.put(key, value, options);
    };
    const deletingBucket = overrideBucket({ put });
    const deleting = fetchWithEnv(
      { ...configuredEnv(), SNAPSHOTS: deletingBucket },
      v2SnapshotUrl(SECOND),
      {
        method: "DELETE",
        headers: await v2WriteHeaders({
          "If-Match": second.headers.get("ETag")!,
        }),
      },
    );
    await reachedDeleteCas.promise;

    const advanced = await putV2Head(SECOND, { "If-Match": oldManifestEtag });
    expect(advanced.status).toBe(200);
    releaseDeleteCas.resolve();
    expect((await deleting).status).toBe(412);

    expect(await (await getV2Head()).json()).toMatchObject({ snapshot: SECOND });
    const listed = await (await listV2Snapshots()).json() as V2SnapshotListBody;
    expect(listed.items.find((item) => item.name === SECOND)?.isHead).toBe(true);
  });

  it("lets DELETE(B) win over a stale head=>B manifest CAS", async () => {
    expect((await putV2Snapshot(FIRST, vpbeBody(0x11))).status).toBe(201);
    const second = await putV2Snapshot(SECOND, vpbeBody(0x22));
    expect(second.status).toBe(201);
    const createdHead = await putV2Head(FIRST, { "If-None-Match": "*" });

    const reachedHeadCas = deferred();
    const releaseHeadCas = deferred();
    const put: R2Bucket["put"] = async (key, value, options) => {
      if (isManifestMutation(key, value, (manifest) => {
        const head = manifest.head as Record<string, unknown>;
        return head.snapshot === SECOND;
      })) {
        reachedHeadCas.resolve();
        await releaseHeadCas.promise;
      }
      return env.SNAPSHOTS.put(key, value, options);
    };
    const advancing = putHeadWithBucket(
      overrideBucket({ put }),
      SECOND,
      createdHead.headers.get("ETag")!,
    );
    await reachedHeadCas.promise;

    const deleted = await deleteV2Snapshot(SECOND, second.headers.get("ETag")!);
    expect(deleted.status).toBe(204);
    releaseHeadCas.resolve();
    expect((await advancing).status).toBe(412);

    expect(await (await getV2Head()).json()).toMatchObject({ snapshot: FIRST });
    const listed = await (await listV2Snapshots()).json() as V2SnapshotListBody;
    expect(listed.items.map((item) => item.name)).not.toContain(SECOND);
  });

  it("keeps a delayed list internally consistent with its manifest ETag", async () => {
    expect((await putV2Snapshot(FIRST, vpbeBody(0x11))).status).toBe(201);
    expect((await putV2Snapshot(SECOND, vpbeBody(0x22))).status).toBe(201);
    const createdHead = await putV2Head(FIRST, { "If-None-Match": "*" });
    const oldEtag = createdHead.headers.get("ETag")!;

    const capturedManifest = deferred();
    const releaseManifest = deferred();
    let delayed = true;
    const get: R2Bucket["get"] = async (key, options) => {
      const object = await env.SNAPSHOTS.get(key, options);
      if (key === "manifest.json" && delayed) {
        delayed = false;
        capturedManifest.resolve();
        await releaseManifest.promise;
      }
      return object;
    };
    const oldListPromise = fetchWithEnv(
      { ...configuredEnv(), SNAPSHOTS: overrideBucket({ get }) },
      V2_SNAPSHOTS_URL,
      { headers: await authHeaders() },
    );
    await capturedManifest.promise;
    const advanced = await putV2Head(SECOND, { "If-Match": oldEtag });
    expect(advanced.status).toBe(200);
    releaseManifest.resolve();

    const oldListResponse = await oldListPromise;
    const oldList = await oldListResponse.json() as V2SnapshotListBody;
    expect(oldListResponse.headers.get("ETag")).toBe(oldEtag);
    expect(oldList.items.filter((item) => item.isHead).map((item) => item.name))
      .toEqual([FIRST]);
    const currentHead = await getV2Head();
    expect(currentHead.headers.get("ETag")).toBe(advanced.headers.get("ETag"));
    expect(await currentHead.json()).toMatchObject({ snapshot: SECOND });
  });

  it("allows exactly one competing head manifest CAS", async () => {
    expect((await putV2Snapshot(FIRST, vpbeBody(0x11))).status).toBe(201);
    expect((await putV2Snapshot(SECOND, vpbeBody(0x22))).status).toBe(201);
    expect((await putV2Snapshot(THIRD, vpbeBody(0x33))).status).toBe(201);
    const createdHead = await putV2Head(FIRST, { "If-None-Match": "*" });
    const etag = createdHead.headers.get("ETag")!;

    const reachedCas = deferred();
    const releaseCas = deferred();
    const put: R2Bucket["put"] = async (key, value, options) => {
      if (isManifestMutation(key, value, (manifest) => {
        const head = manifest.head as Record<string, unknown>;
        return head.snapshot === SECOND;
      })) {
        reachedCas.resolve();
        await releaseCas.promise;
      }
      return env.SNAPSHOTS.put(key, value, options);
    };
    const firstUpdate = putHeadWithBucket(overrideBucket({ put }), SECOND, etag);
    await reachedCas.promise;
    const secondUpdate = await putV2Head(THIRD, { "If-Match": etag });
    expect(secondUpdate.status).toBe(200);
    releaseCas.resolve();
    expect((await firstUpdate).status).toBe(412);
    expect(await (await getV2Head()).json()).toMatchObject({ snapshot: THIRD });
  });

  it("keeps a logically deleted snapshot hidden until failed physical GC recovers", async () => {
    const second = await putV2Snapshot(SECOND, vpbeBody(0x22));
    expect(second.status).toBe(201);
    const oldBodyKey = await bodyKeyFor(SECOND);
    const deleteMethod: R2Bucket["delete"] = async (keys) => {
      if (Array.isArray(keys) && keys.includes(oldBodyKey)) {
        throw new Error("physical delete unavailable");
      }
      return env.SNAPSHOTS.delete(keys);
    };
    const failingBucket = overrideBucket({ delete: deleteMethod });
    const deleted = await fetchWithEnv(
      { ...configuredEnv(), SNAPSHOTS: failingBucket },
      v2SnapshotUrl(SECOND),
      {
        method: "DELETE",
        headers: await v2WriteHeaders({
          "If-Match": second.headers.get("ETag")!,
        }),
      },
    );
    expect(deleted.status).toBe(204);
    expect(await env.SNAPSHOTS.head(oldBodyKey)).not.toBeNull();

    const hiddenList = await fetchWithEnv(
      { ...configuredEnv(), SNAPSHOTS: failingBucket },
      V2_SNAPSHOTS_URL,
      { headers: await authHeaders() },
    );
    const hidden = await hiddenList.json() as V2SnapshotListBody;
    expect(hidden.items.map((item) => item.name)).not.toContain(SECOND);
    const hiddenGet = await fetchWithEnv(
      { ...configuredEnv(), SNAPSHOTS: failingBucket },
      v2SnapshotUrl(SECOND),
      { headers: await authHeaders() },
    );
    expect(hiddenGet.status).toBe(404);

    const recovered = await listV2Snapshots();
    expect(recovered.status).toBe(200);
    expect(await env.SNAPSHOTS.head(oldBodyKey)).toBeNull();
    const reused = await putV2Snapshot(SECOND, vpbeBody(0x44));
    expect(reused.status).toBe(201);
    expect(await bodyKeyFor(SECOND)).not.toBe(oldBodyKey);
    expect((await getV2Snapshot(SECOND)).status).toBe(200);
  });

  it("eventually reclaims a registration CAS orphan without client retry", async () => {
    expect((await putV2Snapshot(FIRST, vpbeBody(0x11))).status).toBe(201);
    const reachedRegistration = deferred();
    const releaseRegistration = deferred();
    const put: R2Bucket["put"] = async (key, value, options) => {
      if (isManifestMutation(key, value, (manifest) => {
        const snapshots = manifest.snapshots as Array<Record<string, unknown>>;
        return snapshots.some((item) => item.name === SECOND);
      })) {
        reachedRegistration.resolve();
        await releaseRegistration.promise;
      }
      return env.SNAPSHOTS.put(key, value, options);
    };
    const payload = vpbeBody(0x22);
    const losingUpload = fetchWithEnv(
      { ...configuredEnv(), SNAPSHOTS: overrideBucket({ put }) },
      v2SnapshotUrl(SECOND),
      {
        method: "PUT",
        headers: await v2WriteHeaders({
          "Content-Type": "application/octet-stream",
          "If-None-Match": "*",
        }),
        body: payload,
      },
    );
    await reachedRegistration.promise;
    expect((await putV2Snapshot(THIRD, vpbeBody(0x33))).status).toBe(201);
    releaseRegistration.resolve();
    expect((await losingUpload).status).toBe(412);

    expect((await getV2Snapshot(SECOND)).status).toBe(404);
    const hidden = await (await listV2Snapshots()).json() as V2SnapshotListBody;
    expect(hidden.items.map((item) => item.name)).not.toContain(SECOND);

    const manifest = await storedManifest();
    const referenced = new Set(manifest.snapshots.map((item) => item.bodyKey));
    const bodies = await env.SNAPSHOTS.list({ prefix: "bodies/" });
    const orphan = bodies.objects.find((object) => !referenced.has(object.key));
    expect(orphan).toBeTruthy();
    const orphanBody = await env.SNAPSHOTS.get(orphan!.key);
    expect(orphanBody).not.toBeNull();
    await env.SNAPSHOTS.put(orphan!.key, await orphanBody!.arrayBuffer(), {
      customMetadata: { gcAfter: "0" },
      httpMetadata: { contentType: "application/octet-stream" },
    });
    await env.SNAPSHOTS.delete("gc-state.json");

    expect((await listV2Snapshots()).status).toBe(200);
    expect(await env.SNAPSHOTS.head(orphan!.key)).toBeNull();
    expect((await getV2Snapshot(SECOND)).status).toBe(404);
  });

  it("keeps manifest deletion metadata bounded after many generations", async () => {
    for (let sequence = 10; sequence < 90; sequence++) {
      const filename = snapshotFilename("auto", sequence);
      const created = await putV2Snapshot(filename, vpbeBody(sequence));
      expect(created.status).toBe(201);
      const deleted = await deleteV2Snapshot(filename, created.headers.get("ETag")!);
      expect(deleted.status).toBe(204);
    }
    const manifest = await storedManifest();
    expect(manifest.snapshots).toEqual([]);
    expect(manifest.pendingDeletes).toEqual([]);
    const stored = await env.SNAPSHOTS.get("manifest.json");
    expect((await stored!.text()).length).toBeLessThan(256);
  });

  it("uses a fixed pending-delete budget and recovers across later requests", async () => {
    const snapshots: Array<{ filename: string; etag: string }> = [];
    for (let sequence = 10; sequence < 20; sequence++) {
      const filename = snapshotFilename("backup", sequence);
      const created = await putV2Snapshot(filename, vpbeBody(sequence));
      snapshots.push({ filename, etag: created.headers.get("ETag")! });
    }

    let deleteCalls = 0;
    let largestBatch = 0;
    const failingDelete: R2Bucket["delete"] = async (keys) => {
      deleteCalls += 1;
      largestBatch = Math.max(largestBatch, Array.isArray(keys) ? keys.length : 1);
      throw new Error("physical delete unavailable");
    };
    const failingBucket = overrideBucket({ delete: failingDelete });
    for (const snapshot of snapshots) {
      const response = await fetchWithEnv(
        { ...configuredEnv(), SNAPSHOTS: failingBucket },
        v2SnapshotUrl(snapshot.filename),
        {
          method: "DELETE",
          headers: await v2WriteHeaders({ "If-Match": snapshot.etag }),
        },
      );
      expect(response.status).toBe(204);
    }
    expect((await storedManifest()).pendingDeletes).toHaveLength(10);

    deleteCalls = 0;
    largestBatch = 0;
    let r2Calls = 0;
    const countedGet: R2Bucket["get"] = async (key, options) => {
      r2Calls += 1;
      return env.SNAPSHOTS.get(key, options);
    };
    const countedList: R2Bucket["list"] = async (options) => {
      r2Calls += 1;
      return env.SNAPSHOTS.list(options);
    };
    const countedPut: R2Bucket["put"] = async (key, value, options) => {
      r2Calls += 1;
      return env.SNAPSHOTS.put(key, value, options);
    };
    const countedDelete: R2Bucket["delete"] = async (keys) => {
      r2Calls += 1;
      return failingDelete(keys);
    };
    const bounded = await fetchWithEnv(
      {
        ...configuredEnv(),
        SNAPSHOTS: overrideBucket({
          delete: countedDelete,
          get: countedGet,
          list: countedList,
          put: countedPut,
        }),
      },
      V2_SNAPSHOTS_URL,
      { headers: await authHeaders() },
    );
    expect(bounded.status).toBe(200);
    expect(deleteCalls).toBe(1);
    expect(largestBatch).toBe(2);
    expect(r2Calls).toBeLessThanOrEqual(4);
    expect((await storedManifest()).pendingDeletes).toHaveLength(10);

    for (const remaining of [8, 6, 4, 2, 0]) {
      expect((await listV2Snapshots()).status).toBe(200);
      expect((await storedManifest()).pendingDeletes).toHaveLength(remaining);
    }
  });

  it("caps failed cleanup metadata instead of growing the manifest forever", async () => {
    const snapshots: Array<{ filename: string; etag: string }> = [];
    for (let sequence = 100; sequence < 165; sequence++) {
      const filename = snapshotFilename("backup", sequence);
      const created = await putV2Snapshot(filename, vpbeBody(sequence));
      snapshots.push({ filename, etag: created.headers.get("ETag")! });
    }
    const alwaysFail: R2Bucket["delete"] = async () => {
      throw new Error("physical delete unavailable");
    };
    const failingBucket = overrideBucket({ delete: alwaysFail });
    for (const snapshot of snapshots.slice(0, 64)) {
      const response = await fetchWithEnv(
        { ...configuredEnv(), SNAPSHOTS: failingBucket },
        v2SnapshotUrl(snapshot.filename),
        {
          method: "DELETE",
          headers: await v2WriteHeaders({ "If-Match": snapshot.etag }),
        },
      );
      expect(response.status).toBe(204);
    }
    const overflow = snapshots[64]!;
    const rejected = await fetchWithEnv(
      { ...configuredEnv(), SNAPSHOTS: failingBucket },
      v2SnapshotUrl(overflow.filename),
      {
        method: "DELETE",
        headers: await v2WriteHeaders({ "If-Match": overflow.etag }),
      },
    );
    expect(rejected.status).toBe(503);
    expect((await rejected.json() as ErrorBody).error.code).toBe("gc_backlog_full");
    const manifest = await storedManifest();
    expect(manifest.pendingDeletes).toHaveLength(64);
    expect(manifest.snapshots.map((item) => item.name)).toEqual([overflow.filename]);
  });

  it("never lets stale GC delete a replacement generation with the same filename", async () => {
    const old = await putV2Snapshot(SECOND, vpbeBody(0x22));
    const oldBodyKey = await bodyKeyFor(SECOND);
    const alwaysFail: R2Bucket["delete"] = async () => {
      throw new Error("physical delete unavailable");
    };
    const logicalDelete = await fetchWithEnv(
      { ...configuredEnv(), SNAPSHOTS: overrideBucket({ delete: alwaysFail }) },
      v2SnapshotUrl(SECOND),
      {
        method: "DELETE",
        headers: await v2WriteHeaders({ "If-Match": old.headers.get("ETag")! }),
      },
    );
    expect(logicalDelete.status).toBe(204);

    const reachedOldDelete = deferred();
    const releaseOldDelete = deferred();
    const delayedDelete: R2Bucket["delete"] = async (keys) => {
      if (Array.isArray(keys) && keys.includes(oldBodyKey)) {
        reachedOldDelete.resolve();
        await releaseOldDelete.promise;
      }
      return env.SNAPSHOTS.delete(keys);
    };
    const staleGc = fetchWithEnv(
      { ...configuredEnv(), SNAPSHOTS: overrideBucket({ delete: delayedDelete }) },
      V2_SNAPSHOTS_URL,
      { headers: await authHeaders() },
    );
    await reachedOldDelete.promise;

    const replacementPayload = vpbeBody(0x44);
    const replacement = await putV2Snapshot(SECOND, replacementPayload);
    expect(replacement.status).toBe(201);
    const replacementKey = await bodyKeyFor(SECOND);
    expect(replacementKey).not.toBe(oldBodyKey);
    releaseOldDelete.resolve();
    expect((await staleGc).status).toBe(200);

    expect(await env.SNAPSHOTS.head(replacementKey)).not.toBeNull();
    expect(new Uint8Array(await (await getV2Snapshot(SECOND)).arrayBuffer()))
      .toEqual(replacementPayload);
  });
});

describe("snapshot-only v2 request stream failures", () => {
  it("maps reader.read failure to a stable JSON error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("read failed");
      },
    });
    const response = await fetchConfigured(v2SnapshotUrl(FIRST), {
      method: "PUT",
      headers: await v2WriteHeaders({
        "Content-Type": "application/octet-stream",
        "If-None-Match": "*",
      }),
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json\b/);
    expect((await response.json() as ErrorBody).error.code).toBe("invalid_body");
  });

  it("keeps the 413 JSON response when reader.cancel fails", async () => {
    const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
    oversized.set(vpbeBody());
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
      },
      cancel() {
        throw new Error("cancel failed");
      },
    });
    const response = await fetchConfigured(v2SnapshotUrl(FIRST), {
      method: "PUT",
      headers: await v2WriteHeaders({
        "Content-Type": "application/octet-stream",
        "If-None-Match": "*",
      }),
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json\b/);
    expect((await response.json() as ErrorBody).error.code).toBe("payload_too_large");
  });
});
