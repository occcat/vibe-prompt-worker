import { describe, expect, it } from "vitest";

import { parseObjectPath } from "../src/paths";
import { PROMPT_ID } from "./helpers";

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
});
