export const OBJECTS_PER_MINUTE = 600;
export const RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT_META_KEY = "rate_limit_objects";

export type RateEvent = {
  at: number;
  n: number;
};

export type RateWindow = {
  events: RateEvent[];
};

export function emptyRateWindow(): RateWindow {
  return { events: [] };
}

export function parseRateWindow(raw: string | null): RateWindow {
  if (raw === null || raw === "") {
    return emptyRateWindow();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return emptyRateWindow();
  }
  if (typeof parsed !== "object" || parsed === null) {
    return emptyRateWindow();
  }
  const events = (parsed as { events?: unknown }).events;
  if (!Array.isArray(events)) {
    return emptyRateWindow();
  }
  const next: RateEvent[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null) {
      continue;
    }
    const at = (event as { at?: unknown }).at;
    const n = (event as { n?: unknown }).n;
    if (
      typeof at !== "number" ||
      typeof n !== "number" ||
      !Number.isFinite(at) ||
      !Number.isSafeInteger(n) ||
      n <= 0
    ) {
      continue;
    }
    next.push({ at, n });
  }
  return { events: next };
}

export function serializeRateWindow(window: RateWindow): string {
  return JSON.stringify({ events: window.events });
}

export function tryConsumeObjects(
  window: RateWindow,
  n: number,
  now: number,
  limit = OBJECTS_PER_MINUTE,
  windowMs = RATE_WINDOW_MS,
): { ok: boolean; window: RateWindow } {
  const cutoff = now - windowMs;
  const events = window.events.filter((event) => event.at > cutoff);
  const pruned: RateWindow = { events };
  if (!Number.isSafeInteger(n) || n < 0) {
    return { ok: false, window: pruned };
  }
  if (n === 0) {
    return { ok: true, window: pruned };
  }
  let used = 0;
  for (const event of events) {
    used += event.n;
  }
  if (used + n > limit) {
    return { ok: false, window: pruned };
  }
  return { ok: true, window: { events: [...events, { at: now, n }] } };
}
