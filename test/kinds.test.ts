import { describe, expect, it } from "vitest";

import {
  LIVE_KIND_SPECS,
  classifyBlobPath,
  liveBlobPath,
  tombstoneBlobPath,
} from "../src/kinds";
import { PROMPT_ID } from "./helpers";

describe("classifyBlobPath", () => {
  it("classifies every registry live blob and matching tombstone blob", () => {
    for (const spec of LIVE_KIND_SPECS) {
      const id = spec.singular === "scope" ? "team.scope-1" : PROMPT_ID;
      expect(classifyBlobPath(liveBlobPath(spec.url, id))).toEqual({
        type: "live",
        urlKind: spec.url,
        singular: spec.singular,
        id,
      });
      expect(classifyBlobPath(tombstoneBlobPath(spec.singular, id))).toEqual({
        type: "tombstone",
        targetKind: spec.singular,
        id,
      });
    }
  });

  it("ignores unknown prefixes and the wrong blob suffix", () => {
    expect(classifyBlobPath(`objects/unknown/${PROMPT_ID}.vpb`)).toBeNull();
    expect(classifyBlobPath(`objects/prompts/${PROMPT_ID}.json`)).toBeNull();
    expect(classifyBlobPath(`objects/tombstones/prompt/${PROMPT_ID}.vpb`))
      .toBeNull();
    expect(classifyBlobPath("vault.json")).toBeNull();
  });
});
