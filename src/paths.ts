import { SCOPE_ID_RE, UUID_RE } from "./validate";

export type LiveUrlKind = "prompts" | "labels" | "scopes";
export type SingularKind = "prompt" | "label" | "scope";

const LIVE_KINDS: Record<LiveUrlKind, SingularKind> = {
  prompts: "prompt",
  labels: "label",
  scopes: "scope",
};

const SINGULAR_TO_URL: Record<SingularKind, LiveUrlKind> = {
  prompt: "prompts",
  label: "labels",
  scope: "scopes",
};

export type ParsedLiveObject = {
  type: "live";
  urlKind: LiveUrlKind;
  indexKind: SingularKind;
  id: string;
  blobPath: string;
  tombstoneBlobPath: string;
  tombstoneIndexId: string;
};

export type ParsedTombstoneObject = {
  type: "tombstone";
  targetKind: SingularKind;
  liveUrlKind: LiveUrlKind;
  id: string;
  blobPath: string;
  liveBlobPath: string;
  indexId: string;
};

export type ParsedObject = ParsedLiveObject | ParsedTombstoneObject;

export type ParseObjectPathResult =
  | { ok: true; value: ParsedObject }
  | { ok: false; reason: "not_object" | "invalid_path" };

export function liveBlobPath(urlKind: LiveUrlKind, id: string): string {
  return `objects/${urlKind}/${id}.vpb`;
}

export function tombstoneBlobPath(kind: SingularKind, id: string): string {
  return `objects/tombstones/${kind}/${id}.json`;
}

function hasNonAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 127) {
      return true;
    }
  }
  return false;
}

function isLiveId(urlKind: LiveUrlKind, id: string): boolean {
  if (urlKind === "scopes") {
    return SCOPE_ID_RE.test(id);
  }
  return UUID_RE.test(id);
}

function liveObject(urlKind: LiveUrlKind, id: string): ParsedLiveObject {
  const indexKind = LIVE_KINDS[urlKind];
  return {
    type: "live",
    urlKind,
    indexKind,
    id,
    blobPath: liveBlobPath(urlKind, id),
    tombstoneBlobPath: tombstoneBlobPath(indexKind, id),
    tombstoneIndexId: `${indexKind}:${id}`,
  };
}

function tombstoneObject(targetKind: SingularKind, id: string): ParsedTombstoneObject {
  const liveUrlKind = SINGULAR_TO_URL[targetKind];
  return {
    type: "tombstone",
    targetKind,
    liveUrlKind,
    id,
    blobPath: tombstoneBlobPath(targetKind, id),
    liveBlobPath: liveBlobPath(liveUrlKind, id),
    indexId: `${targetKind}:${id}`,
  };
}

export function parseObjectPath(pathname: string): ParseObjectPathResult {
  if (!pathname.startsWith("/v1/objects")) {
    return { ok: false, reason: "not_object" };
  }
  if (pathname.includes("..") || pathname.includes("\\") || hasNonAscii(pathname)) {
    return { ok: false, reason: "invalid_path" };
  }
  const parts = pathname.split("/");
  if (parts.length !== 5 || parts[1] !== "v1" || parts[2] !== "objects") {
    return { ok: false, reason: "invalid_path" };
  }
  const urlKind = parts[3];
  let id: string;
  try {
    id = decodeURIComponent(parts[4] ?? "");
  } catch {
    return { ok: false, reason: "invalid_path" };
  }
  if (id === "") {
    return { ok: false, reason: "invalid_path" };
  }
  if (urlKind === "prompts" || urlKind === "labels" || urlKind === "scopes") {
    if (!isLiveId(urlKind, id)) {
      return { ok: false, reason: "invalid_path" };
    }
    return { ok: true, value: liveObject(urlKind, id) };
  }
  if (urlKind === "tombstones") {
    const colon = id.indexOf(":");
    if (colon <= 0) {
      return { ok: false, reason: "invalid_path" };
    }
    const targetKind = id.slice(0, colon);
    const targetId = id.slice(colon + 1);
    if (
      targetKind !== "prompt" &&
      targetKind !== "label" &&
      targetKind !== "scope"
    ) {
      return { ok: false, reason: "invalid_path" };
    }
    const liveKind = SINGULAR_TO_URL[targetKind];
    if (!isLiveId(liveKind, targetId)) {
      return { ok: false, reason: "invalid_path" };
    }
    return { ok: true, value: tombstoneObject(targetKind, targetId) };
  }
  return { ok: false, reason: "not_object" };
}
