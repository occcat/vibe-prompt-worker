import {
  isLiveId,
  isLiveUrlKind,
  isSingularKind,
  LIVE_KINDS,
  SINGULAR_TO_URL,
  type LiveUrlKind,
  type SingularKind,
} from "./kinds";

export type { LiveUrlKind, SingularKind };

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

export type SnapshotKind = "auto" | "backup";

export type ParsedSnapshotList = {
  type: "list";
};

export type ParsedSnapshotItem = {
  type: "item";
  filename: string;
  kind: SnapshotKind;
};

export type ParsedSnapshot = ParsedSnapshotList | ParsedSnapshotItem;

export type ParseSnapshotPathResult =
  | { ok: true; value: ParsedSnapshot }
  | { ok: false; reason: "not_snapshot" | "invalid_path" };

const SNAPSHOT_FILENAME_RE =
  /^vibe-prompt-(auto|backup)_(\d{8}T\d{6}Z)_([0-9a-f]{8})_([0-9a-f]{6})\.vpb$/;

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
  if (isLiveUrlKind(urlKind)) {
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
    if (!isSingularKind(targetKind)) {
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

export function isSnapshotRoute(pathname: string): boolean {
  return pathname === "/v1/snapshots" || pathname.startsWith("/v1/snapshots/");
}

export function parseSnapshotPath(pathname: string): ParseSnapshotPathResult {
  if (pathname === "/v1/snapshots") {
    return { ok: true, value: { type: "list" } };
  }
  if (!pathname.startsWith("/v1/snapshots/")) {
    return { ok: false, reason: "not_snapshot" };
  }
  if (pathname.includes("..") || pathname.includes("\\") || hasNonAscii(pathname)) {
    return { ok: false, reason: "invalid_path" };
  }
  const rest = pathname.slice("/v1/snapshots/".length);
  if (rest === "" || rest.includes("/")) {
    return { ok: false, reason: "invalid_path" };
  }
  let filename: string;
  try {
    filename = decodeURIComponent(rest);
  } catch {
    return { ok: false, reason: "invalid_path" };
  }
  const match = SNAPSHOT_FILENAME_RE.exec(filename);
  const kind = match?.[1];
  if (kind !== "auto" && kind !== "backup") {
    return { ok: false, reason: "invalid_path" };
  }
  return {
    ok: true,
    value: {
      type: "item",
      filename,
      kind,
    },
  };
}
