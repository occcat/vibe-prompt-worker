import { beforeEach, describe, expect, it } from "vitest";

import {
  configuredEnv,
  fetchConfigured,
  fetchWithEnv,
  getIndex,
  getObject,
  getSnapshot,
  getSnapshots,
  objectUrl,
  PROMPT_ID,
  putObject,
  putSnapshot,
  putVault,
  snapshotFilename,
  snapshotUrl,
  vaultDocument,
  vpbeBody,
  vpbpBody,
  writeHeaders,
  type ErrorBody,
  type IndexBody,
  type SnapshotListBody,
} from "./helpers";

const LIVE_URL = objectUrl("prompts", PROMPT_ID);
const AUTO_NAME = snapshotFilename("auto", 1);
const BACKUP_NAME = snapshotFilename("backup", 0);

describe("R2 snapshots", () => {
  beforeEach(async () => {
    expect((await putVault(vaultDocument())).status).toBe(201);
  });

  it("PUT VPBE If-None-Match:* does not bump index.revision", async () => {
    const createdObject = await putObject(LIVE_URL, vpbeBody());
    expect(createdObject.status).toBe(201);
    const before = await (await getIndex()).json() as IndexBody;
    expect(before.revision).toBe(2);

    const created = await putSnapshot(AUTO_NAME, vpbeBody());
    expect([201, 204]).toContain(created.status);

    const list = await getSnapshots();
    expect(list.status).toBe(200);
    const listed = await list.json() as SnapshotListBody;
    expect(listed.items.map((item) => item.filename)).toContain(AUTO_NAME);

    const afterList = await (await getIndex()).json() as IndexBody;
    expect(afterList.revision).toBe(before.revision);

    const object = await getObject(LIVE_URL);
    expect(object.status).toBe(200);
    expect(object.headers.get("X-Vibe-Prompt-Revision")).toBe("2");
    const afterObject = await (await getIndex()).json() as IndexBody;
    expect(afterObject.revision).toBe(before.revision);
  });

  it("GET snapshot body matches the PUT payload", async () => {
    const payload = vpbeBody(0xab);
    const created = await putSnapshot(AUTO_NAME, payload);
    expect(created.status).toBe(201);

    const got = await getSnapshot(AUTO_NAME);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toMatch(/^application\/octet-stream\b/);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(payload);
  });

  it("PUT VPBP with encryption=required is 400 invalid_magic", async () => {
    const response = await putSnapshot(AUTO_NAME, vpbpBody());
    expect(response.status).toBe(400);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("invalid_magic");
  });

  it("PUT with a bad filename is 400 invalid_path", async () => {
    const response = await putSnapshot("not-a-snapshot.vpb", vpbeBody());
    expect(response.status).toBe(400);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("invalid_path");
  });

  it("PUT with Content-Length 20971521 is 413 without buffering the body", async () => {
    const response = await fetchConfigured(snapshotUrl(AUTO_NAME), {
      method: "PUT",
      headers: await writeHeaders({
        "If-None-Match": "*",
        "Content-Length": "20971521",
      }),
      body: vpbeBody(),
    });
    expect(response.status).toBe(413);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("payload_too_large");
  });

  it("the 31st auto_ snapshot GCs the oldest auto_ and keeps backup_", async () => {
    expect((await putSnapshot(BACKUP_NAME, vpbeBody(0x11))).status).toBe(201);
    for (let seq = 1; seq <= 31; seq++) {
      const created = await putSnapshot(snapshotFilename("auto", seq), vpbeBody());
      expect(created.status).toBe(201);
    }

    const listed = await (await getSnapshots()).json() as SnapshotListBody;
    const names = listed.items.map((item) => item.filename);
    expect(names).toContain(BACKUP_NAME);
    expect(names).not.toContain(snapshotFilename("auto", 1));
    expect(names.filter((name) => name.includes("-auto_"))).toHaveLength(30);
    expect(names).toContain(snapshotFilename("auto", 31));
    expect((await getSnapshot(snapshotFilename("auto", 1))).status).toBe(404);
    expect((await getSnapshot(BACKUP_NAME)).status).toBe(200);
  });

  it("missing SNAPSHOTS binding is 503 for snapshot PUT but object PUT still 204", async () => {
    const created = await putObject(LIVE_URL, vpbeBody());
    expect(created.status).toBe(201);
    const etag = created.headers.get("ETag");
    expect(etag).toBeTruthy();

    const envWithoutSnapshots = {
      ...configuredEnv(),
      SNAPSHOTS: undefined,
    } as unknown as Env;

    const snapshotResponse = await fetchWithEnv(
      envWithoutSnapshots,
      snapshotUrl(AUTO_NAME),
      {
        method: "PUT",
        headers: await writeHeaders({ "If-None-Match": "*" }),
        body: vpbeBody(),
      },
    );
    expect(snapshotResponse.status).toBe(503);
    const snapshotBody = await snapshotResponse.json() as ErrorBody;
    expect(snapshotBody.error.code).toBe("misconfigured");

    const objectResponse = await fetchWithEnv(
      envWithoutSnapshots,
      LIVE_URL,
      {
        method: "PUT",
        headers: await writeHeaders({ "If-Match": etag! }),
        body: vpbeBody(0xcd),
      },
    );
    expect(objectResponse.status).toBe(204);
  });
});
