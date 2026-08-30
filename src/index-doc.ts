import { canonicalJson } from "./canonical";
import { classifyBlobPath, type SingularKind } from "./kinds";
import { indexWouldExceedLimit } from "./limits";
import {
  META_INDEX_UPDATED_AT,
  all,
  getMeta,
  objectRevision,
} from "./sql";

export const INDEX_SCHEMA = "vibe-prompt.index/1";
export const ZERO_TIME = "1970-01-01T00:00:00.000Z";

export type IndexKind = SingularKind | "tombstone";

export type IndexItem = {
  bytes: number;
  deleted: boolean;
  etag: string;
  id: string;
  kind: IndexKind;
  revision: number;
  updatedAt: string;
};

export type IndexDocument = {
  items: IndexItem[];
  revision: number;
  schema: typeof INDEX_SCHEMA;
  updatedAt: string;
};

export type BlobMetaRow = {
  path: string;
  etag: string;
  revision: number;
  bytes: number;
  updated_at: string;
};

export function blobToItem(row: BlobMetaRow): IndexItem | null {
  const classified = classifyBlobPath(row.path);
  if (classified === null) {
    return null;
  }
  if (classified.type === "live") {
    return liveItem(classified.singular, classified.id, row);
  }
  return {
    bytes: row.bytes,
    deleted: true,
    etag: row.etag,
    id: `${classified.targetKind}:${classified.id}`,
    kind: "tombstone",
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function liveItem(kind: SingularKind, id: string, row: BlobMetaRow): IndexItem {
  return {
    bytes: row.bytes,
    deleted: false,
    etag: row.etag,
    id,
    kind,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export function sortItems(items: IndexItem[]): IndexItem[] {
  return [...items].sort(compareIndexItems);
}

export function buildIndex(sql: SqlStorage): IndexDocument {
  const items: IndexItem[] = [];
  for (const row of all<BlobMetaRow>(
    sql,
    "SELECT path, etag, revision, bytes, updated_at FROM blobs",
  )) {
    const item = blobToItem(row);
    if (item !== null) {
      items.push(item);
    }
  }
  items.sort(compareIndexItems);
  return {
    items,
    revision: objectRevision(sql),
    schema: INDEX_SCHEMA,
    updatedAt: getMeta(sql, META_INDEX_UPDATED_AT) ?? ZERO_TIME,
  };
}

export function wouldExceedIndex(
  sql: SqlStorage,
  dropIds: string[],
  next: IndexItem,
): boolean {
  const current = buildIndex(sql);
  const drop = new Set(dropIds);
  const items = sortItems([
    ...current.items.filter((item) => !drop.has(item.id)),
    next,
  ]);
  const preview: IndexDocument = {
    items,
    revision: next.revision,
    schema: INDEX_SCHEMA,
    updatedAt: next.updatedAt,
  };
  const serialized = new TextEncoder().encode(canonicalJson(preview)).byteLength;
  return indexWouldExceedLimit(items.length, serialized);
}

function compareIndexItems(left: IndexItem, right: IndexItem): number {
  const kindOrder = left.kind.localeCompare(right.kind);
  if (kindOrder !== 0) {
    return kindOrder;
  }
  return left.id.localeCompare(right.id);
}
