import { describe, expect, it } from "vitest";

import {
  emptyRateWindow,
  OBJECTS_PER_MINUTE,
  RATE_WINDOW_MS,
  tryConsumeObjects,
} from "../src/rate-limit";

describe("tryConsumeObjects", () => {
  it("allows 600 objects and rejects the 601st in the same window", () => {
    const now = 1_700_000_000_000;
    const first = tryConsumeObjects(emptyRateWindow(), OBJECTS_PER_MINUTE, now);
    expect(first.ok).toBe(true);
    const second = tryConsumeObjects(first.window, 1, now + 1);
    expect(second.ok).toBe(false);
    expect(second.window.events).toEqual(first.window.events);
  });

  it("allows another object after the window elapses", () => {
    const now = 1_700_000_000_000;
    const first = tryConsumeObjects(emptyRateWindow(), OBJECTS_PER_MINUTE, now);
    expect(first.ok).toBe(true);
    const later = tryConsumeObjects(first.window, 1, now + RATE_WINDOW_MS);
    expect(later.ok).toBe(true);
  });

  it("rejects a batch that would exceed remaining quota without consuming", () => {
    const now = 1_700_000_000_000;
    const first = tryConsumeObjects(emptyRateWindow(), 500, now);
    expect(first.ok).toBe(true);
    const over = tryConsumeObjects(first.window, 101, now);
    expect(over.ok).toBe(false);
    const fits = tryConsumeObjects(over.window, 100, now);
    expect(fits.ok).toBe(true);
  });
});
