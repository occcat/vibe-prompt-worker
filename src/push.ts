export type PushKind = "prompt" | "label" | "scope" | "tombstone";

export type PushItem = {
  kind: PushKind;
  id: string;
  ifMatch: string | null;
  ifNoneMatch: string | null;
  bodyBase64: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPushKind(value: unknown): value is PushKind {
  return (
    value === "prompt" ||
    value === "label" ||
    value === "scope" ||
    value === "tombstone"
  );
}

function optionalHeader(value: unknown): string | null | false {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return false;
  }
  return value === "" ? null : value;
}

function parsePushItem(value: unknown): PushItem | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!isPushKind(value.kind) || typeof value.id !== "string" || value.id === "") {
    return null;
  }
  if (typeof value.bodyBase64 !== "string") {
    return null;
  }
  const ifMatch = optionalHeader(value.ifMatch);
  const ifNoneMatch = optionalHeader(value.ifNoneMatch);
  if (ifMatch === false || ifNoneMatch === false) {
    return null;
  }
  return {
    kind: value.kind,
    id: value.id,
    ifMatch,
    ifNoneMatch,
    bodyBase64: value.bodyBase64,
  };
}

export function parsePushItems(value: unknown): PushItem[] | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return null;
  }
  const items: PushItem[] = [];
  for (const raw of value.items) {
    const item = parsePushItem(raw);
    if (item === null) {
      return null;
    }
    items.push(item);
  }
  return items;
}

const URL_KIND: Record<Exclude<PushKind, "tombstone">, string> = {
  prompt: "prompts",
  label: "labels",
  scope: "scopes",
};

export function pushItemPath(item: PushItem): string {
  if (item.kind === "tombstone") {
    return `/v1/objects/tombstones/${item.id}`;
  }
  return `/v1/objects/${URL_KIND[item.kind]}/${item.id}`;
}

export function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}
