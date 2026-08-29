import { describe, expect, it } from "vitest";

import { timingSafeEqualBytes } from "../src/auth";

describe("timingSafeEqualBytes", () => {
  it("returns true for identical equal-length buffers", () => {
    const left = new Uint8Array([0xab, 0xcd, 0xef, 0x01]);
    const right = new Uint8Array([0xab, 0xcd, 0xef, 0x01]);
    expect(timingSafeEqualBytes(left, right)).toBe(true);
  });

  it("returns false for equal-length mismatch", () => {
    const left = new Uint8Array([0xab, 0xcd, 0xef, 0x01]);
    const right = new Uint8Array([0xab, 0xcd, 0xef, 0x02]);
    expect(timingSafeEqualBytes(left, right)).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    const left = new Uint8Array([0x01]);
    const right = new Uint8Array([0x01, 0x02]);
    expect(() => timingSafeEqualBytes(left, right)).not.toThrow();
    expect(timingSafeEqualBytes(left, right)).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array(), new Uint8Array([0x00]))).toBe(false);
  });
});
