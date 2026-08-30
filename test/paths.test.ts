import { describe, expect, it } from "vitest";

import { LIVE_KIND_SPECS } from "../src/kinds";
import { parseObjectPath, parseSnapshotPath } from "../src/paths";
import { PROMPT_ID, snapshotFilename } from "./helpers";

describe("parseObjectPath", () => {
  it("accepts live prompt uuids and encoded tombstone ids", () => {
    const live = parseObjectPath(`/v1/objects/prompts/${PROMPT_ID}`);
    expect(live).toEqual({
      ok: true,
      value: {
        type: "live",
        urlKind: "prompts",
        indexKind: "prompt",
        id: PROMPT_ID,
        blobPath: `objects/prompts/${PROMPT_ID}.vpb`,
        tombstoneBlobPath: `objects/tombstones/prompt/${PROMPT_ID}.json`,
        tombstoneIndexId: `prompt:${PROMPT_ID}`,
      },
    });

    const encoded = parseObjectPath(
      `/v1/objects/tombstones/prompt%3A${PROMPT_ID}`,
    );
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(encoded.value.type).toBe("tombstone");
      expect(encoded.value).toMatchObject({
        targetKind: "prompt",
        id: PROMPT_ID,
        indexId: `prompt:${PROMPT_ID}`,
      });
    }
  });

  it("rejects uppercase uuids, traversal, and non-ASCII", () => {
    expect(parseObjectPath(
      "/v1/objects/prompts/11111111-2222-4333-8444-55555555555A",
    )).toEqual({ ok: false, reason: "invalid_path" });
    expect(parseObjectPath("/v1/objects/prompts/../secrets")).toEqual({
      ok: false,
      reason: "invalid_path",
    });
    expect(parseObjectPath("/v1/objects/prompts/prompt-你好")).toEqual({
      ok: false,
      reason: "invalid_path",
    });
  });

  it("accepts every registry live kind and matching tombstone path", () => {
    for (const spec of LIVE_KIND_SPECS) {
      const id = spec.singular === "scope" ? "team.scope-1" : PROMPT_ID;
      const live = parseObjectPath(`/v1/objects/${spec.url}/${id}`);
      expect(live).toMatchObject({
        ok: true,
        value: {
          type: "live",
          urlKind: spec.url,
          indexKind: spec.singular,
          id,
        },
      });
      const tombstone = parseObjectPath(
        `/v1/objects/tombstones/${spec.singular}:${id}`,
      );
      expect(tombstone).toMatchObject({
        ok: true,
        value: {
          type: "tombstone",
          targetKind: spec.singular,
          liveUrlKind: spec.url,
          id,
        },
      });
    }
  });
});

describe("parseSnapshotPath", () => {
  it("accepts the list path and valid auto/backup filenames", () => {
    expect(parseSnapshotPath("/v1/snapshots")).toEqual({
      ok: true,
      value: { type: "list" },
    });
    const autoName = snapshotFilename("auto", 1);
    expect(parseSnapshotPath(`/v1/snapshots/${autoName}`)).toEqual({
      ok: true,
      value: { type: "item", filename: autoName, kind: "auto" },
    });
    const backupName = snapshotFilename("backup", 2);
    expect(parseSnapshotPath(`/v1/snapshots/${backupName}`)).toEqual({
      ok: true,
      value: { type: "item", filename: backupName, kind: "backup" },
    });
  });

  it("rejects invalid snapshot filenames", () => {
    expect(parseSnapshotPath("/v1/snapshots/not-a-snapshot.vpb")).toEqual({
      ok: false,
      reason: "invalid_path",
    });
    expect(parseSnapshotPath("/v1/snapshots/vibe-prompt-auto_bad.vpb")).toEqual({
      ok: false,
      reason: "invalid_path",
    });
  });
});
