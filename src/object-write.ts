import { canonicalJson, formatCanonicalUtc } from "./canonical";
import {
  emptyRevisionResponse,
  errorResponse,
  quoteEtag,
  revisionHeaders,
} from "./http";
import { wouldExceedIndex, type BlobMetaRow, type IndexItem } from "./index-doc";
import { MAX_OBJECT_BYTES } from "./limits";
import { hasVpbeMagic } from "./magic";
import {
  type ParsedLiveObject,
  type ParsedObject,
  type ParsedTombstoneObject,
} from "./paths";
import { evaluateIfMatch, evaluatePreconditions } from "./preconditions";
import {
  META_INDEX_UPDATED_AT,
  META_OBJECT_REVISION,
  objectRevision,
  one,
  setMeta,
} from "./sql";
import {
  parseTombstoneJson,
  type TombstoneDocument,
  type VaultDocument,
} from "./validate";

type BlobRow = BlobMetaRow & {
  body: ArrayBuffer;
};

export type ObjectWriteContext = {
  sql: SqlStorage;
  transactionSync: (closure: () => void) => void;
  loadVault: () => { document: VaultDocument; revision: number } | null;
};

type ObjectWriteCommit = {
  dropIds: string[];
  nextItem: IndexItem | null;
  upsert: { path: string; body: ArrayBuffer } | null;
  deletePath: string | null;
  status: number;
};

function getBlobMeta(sql: SqlStorage, path: string): BlobMetaRow | null {
  return one<BlobMetaRow>(
    sql,
    "SELECT path, etag, revision, bytes, updated_at FROM blobs WHERE path = ?",
    path,
  );
}

function getBlob(sql: SqlStorage, path: string): BlobRow | null {
  return one<BlobRow>(
    sql,
    "SELECT path, etag, revision, bytes, updated_at, body FROM blobs WHERE path = ?",
    path,
  );
}

function upsertBlob(
  sql: SqlStorage,
  path: string,
  etag: string,
  revision: number,
  body: ArrayBuffer,
  updatedAt: string,
): void {
  sql.exec(
    `INSERT INTO blobs (path, etag, revision, bytes, updated_at, body)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       etag = excluded.etag,
       revision = excluded.revision,
       bytes = excluded.bytes,
       updated_at = excluded.updated_at,
       body = excluded.body`,
    path,
    etag,
    revision,
    body.byteLength,
    updatedAt,
    body,
  );
}

function deleteBlob(sql: SqlStorage, path: string): void {
  sql.exec("DELETE FROM blobs WHERE path = ?", path);
}

function utf8Bytes(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export function commitObjectWrite(
  ctx: ObjectWriteContext,
  args: ObjectWriteCommit,
): Response {
  if (
    args.nextItem !== null &&
    wouldExceedIndex(ctx.sql, args.dropIds, args.nextItem)
  ) {
    return errorResponse(507, "index_too_large", "Index too large.");
  }
  const now = args.nextItem?.updatedAt ?? formatCanonicalUtc();
  const revision = args.nextItem?.revision ?? objectRevision(ctx.sql) + 1;
  const etag = args.nextItem?.etag ?? quoteEtag(revision);
  ctx.transactionSync(() => {
    if (args.upsert !== null) {
      upsertBlob(ctx.sql, args.upsert.path, etag, revision, args.upsert.body, now);
    }
    if (args.deletePath !== null) {
      deleteBlob(ctx.sql, args.deletePath);
    }
    setMeta(ctx.sql, META_OBJECT_REVISION, String(revision));
    setMeta(ctx.sql, META_INDEX_UPDATED_AT, now);
  });
  return emptyRevisionResponse(args.status, revision);
}

export function getObject(sql: SqlStorage, path: ParsedObject): Response {
  const row = getBlob(sql, path.blobPath);
  if (row === null) {
    return errorResponse(404, "not_found", "Not Found");
  }
  const headers = revisionHeaders(row.revision);
  if (path.type === "tombstone") {
    headers.set("content-type", "application/json");
  } else {
    headers.set("content-type", "application/octet-stream");
  }
  return new Response(row.body, { status: 200, headers });
}

export async function putObject(
  ctx: ObjectWriteContext,
  request: Request,
  path: ParsedObject,
): Promise<Response> {
  if (path.type === "tombstone") {
    return await putTombstone(ctx, request, path);
  }
  return await putLive(ctx, request, path);
}

async function putLive(
  ctx: ObjectWriteContext,
  request: Request,
  path: ParsedLiveObject,
): Promise<Response> {
  const current = getBlobMeta(ctx.sql, path.blobPath);
  const pre = evaluatePreconditions(
    current !== null,
    current?.etag ?? null,
    current?.revision ?? null,
    request,
  );
  if (pre.type === "error") {
    return pre.response;
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_OBJECT_BYTES) {
    return errorResponse(413, "payload_too_large", "Payload too large.");
  }
  const encryption = ctx.loadVault()?.document.encryption ?? "required";
  if (encryption === "required" && !hasVpbeMagic(new Uint8Array(buffer))) {
    return errorResponse(400, "invalid_magic", "Invalid magic.");
  }

  const now = formatCanonicalUtc();
  const revision = objectRevision(ctx.sql) + 1;
  const etag = quoteEtag(revision);
  return commitObjectWrite(ctx, {
    dropIds: [path.id, path.tombstoneIndexId],
    nextItem: {
      bytes: buffer.byteLength,
      deleted: false,
      etag,
      id: path.id,
      kind: path.indexKind,
      revision,
      updatedAt: now,
    },
    upsert: { path: path.blobPath, body: buffer },
    deletePath: path.tombstoneBlobPath,
    status: pre.mode === "create" ? 201 : 204,
  });
}

async function putTombstone(
  ctx: ObjectWriteContext,
  request: Request,
  path: ParsedTombstoneObject,
): Promise<Response> {
  const current = getBlobMeta(ctx.sql, path.blobPath);
  const pre = evaluatePreconditions(
    current !== null,
    current?.etag ?? null,
    current?.revision ?? null,
    request,
  );
  if (pre.type === "error") {
    return pre.response;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.text()) as unknown;
  } catch {
    return errorResponse(400, "invalid_json", "Invalid JSON.");
  }
  const document = parseTombstoneJson(parsed, {
    targetKind: path.targetKind,
    id: path.id,
  });
  if (document === null) {
    return errorResponse(400, "invalid_json", "Invalid JSON.");
  }

  const body = utf8Bytes(canonicalJson(document));
  if (body.byteLength > MAX_OBJECT_BYTES) {
    return errorResponse(413, "payload_too_large", "Payload too large.");
  }

  const now = formatCanonicalUtc();
  const revision = objectRevision(ctx.sql) + 1;
  const etag = quoteEtag(revision);
  return commitObjectWrite(ctx, {
    dropIds: [path.id, path.indexId],
    nextItem: {
      bytes: body.byteLength,
      deleted: true,
      etag,
      id: path.indexId,
      kind: "tombstone",
      revision,
      updatedAt: now,
    },
    upsert: { path: path.blobPath, body },
    deletePath: path.liveBlobPath,
    status: pre.mode === "create" ? 201 : 204,
  });
}

export function deleteObject(
  ctx: ObjectWriteContext,
  request: Request,
  path: ParsedObject,
): Response {
  if (path.type === "tombstone") {
    return deleteTombstone(ctx, request, path);
  }
  return deleteLive(ctx, request, path);
}

function deleteLive(
  ctx: ObjectWriteContext,
  request: Request,
  path: ParsedLiveObject,
): Response {
  const current = getBlobMeta(ctx.sql, path.blobPath);
  const pre = evaluateIfMatch(
    current !== null,
    current?.etag ?? null,
    current?.revision ?? null,
    request,
  );
  if (pre.type === "error") {
    return pre.response;
  }

  const now = formatCanonicalUtc();
  const revision = objectRevision(ctx.sql) + 1;
  const etag = quoteEtag(revision);
  const document: TombstoneDocument = {
    schema: "vibe-prompt.tombstone/1",
    targetKind: path.indexKind,
    id: path.id,
    deletedAt: now,
  };
  const body = utf8Bytes(canonicalJson(document));
  return commitObjectWrite(ctx, {
    dropIds: [path.id, path.tombstoneIndexId],
    nextItem: {
      bytes: body.byteLength,
      deleted: true,
      etag,
      id: path.tombstoneIndexId,
      kind: "tombstone",
      revision,
      updatedAt: now,
    },
    upsert: { path: path.tombstoneBlobPath, body },
    deletePath: path.blobPath,
    status: 204,
  });
}

function deleteTombstone(
  ctx: ObjectWriteContext,
  request: Request,
  path: ParsedTombstoneObject,
): Response {
  const current = getBlobMeta(ctx.sql, path.blobPath);
  const pre = evaluateIfMatch(
    current !== null,
    current?.etag ?? null,
    current?.revision ?? null,
    request,
  );
  if (pre.type === "error") {
    return pre.response;
  }

  return commitObjectWrite(ctx, {
    dropIds: [],
    nextItem: null,
    upsert: null,
    deletePath: path.blobPath,
    status: 204,
  });
}
