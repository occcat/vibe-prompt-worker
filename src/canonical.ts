const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function formatCanonicalUtc(date = new Date()): string {
  return date.toISOString();
}

export function isCanonicalUtc(value: string): boolean {
  if (!CANONICAL_UTC.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return new Date(parsed).toISOString() === value;
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
