import { describe, expect, it } from "vitest";

import {
  indexWouldExceedLimit,
  isBatchPushTooLarge,
  isObjectPutTooLarge,
  isSnapshotPutTooLarge,
  MAX_BATCH_CONTENT_LENGTH,
  MAX_INDEX_BYTES,
  MAX_INDEX_ITEMS,
  MAX_OBJECT_BYTES,
  MAX_SNAPSHOT_BYTES,
} from "../src/limits";
import { PROMPT_ID, snapshotFilename } from "./helpers";

describe("indexWouldExceedLimit", () => {
  it("allows 8000 items and 4 MiB exactly", () => {
    expect(indexWouldExceedLimit(MAX_INDEX_ITEMS, 100)).toBe(false);
    expect(indexWouldExceedLimit(1, MAX_INDEX_BYTES)).toBe(false);
  });

  it("rejects the 8001st item or any payload over 4 MiB", () => {
    expect(indexWouldExceedLimit(MAX_INDEX_ITEMS + 1, 100)).toBe(true);
    expect(indexWouldExceedLimit(1, MAX_INDEX_BYTES + 1)).toBe(true);
  });
});

describe("isObjectPutTooLarge", () => {
  it("rejects live object PUTs whose Content-Length exceeds 1500000", () => {
    const url = `https://worker.test/v1/objects/prompts/${PROMPT_ID}`;
    const large = new Request(url, {
      method: "PUT",
      headers: { "Content-Length": String(MAX_OBJECT_BYTES + 1) },
    });
    expect(isObjectPutTooLarge(large)).toBe(true);

    const allowed = new Request(url, {
      method: "PUT",
      headers: { "Content-Length": String(MAX_OBJECT_BYTES) },
    });
    expect(isObjectPutTooLarge(allowed)).toBe(false);
  });
});

describe("isSnapshotPutTooLarge", () => {
  it("rejects snapshot PUTs whose Content-Length exceeds 20 MiB", () => {
    const url = `https://worker.test/v1/snapshots/${snapshotFilename("auto", 1)}`;
    const large = new Request(url, {
      method: "PUT",
      headers: { "Content-Length": String(MAX_SNAPSHOT_BYTES + 1) },
    });
    expect(isSnapshotPutTooLarge(large)).toBe(true);

    const allowed = new Request(url, {
      method: "PUT",
      headers: { "Content-Length": String(MAX_SNAPSHOT_BYTES) },
    });
    expect(isSnapshotPutTooLarge(allowed)).toBe(false);
  });
});

describe("isBatchPushTooLarge", () => {
  it("rejects POST /v1/sync/push whose Content-Length exceeds 28 MiB", () => {
    const url = "https://worker.test/v1/sync/push";
    const large = new Request(url, {
      method: "POST",
      headers: { "Content-Length": String(MAX_BATCH_CONTENT_LENGTH + 1) },
    });
    expect(isBatchPushTooLarge(large)).toBe(true);

    const allowed = new Request(url, {
      method: "POST",
      headers: { "Content-Length": String(MAX_BATCH_CONTENT_LENGTH) },
    });
    expect(isBatchPushTooLarge(allowed)).toBe(false);
  });
});
