import { contentLengthOf, takePrefix, toFixedLengthStream } from "./body-stream";
import { formatCanonicalUtc, sortKeys } from "./canonical";
import { errorResponse, jsonResponse } from "./http";
import { hasVpbeMagic } from "./magic";
import { type ParsedSnapshot, type ParsedSnapshotItem } from "./paths";
import { evaluateIfMatch, evaluatePreconditions } from "./preconditions";
import { all, objectRevision, one } from "./sql";
import { type VaultDocument } from "./validate";

const SNAPSHOTS_SCHEMA = "vibe-prompt.snapshots/1";
const SNAPSHOTS_MISCONFIGURED = "Must bind SNAPSHOTS R2 bucket.";

export type SnapshotContext = {
  sql: SqlStorage;
  env: Env;
  loadVault: () => { document: VaultDocument; revision: number } | null;
};

type SnapshotRow = {
  filename: string;
  etag: string;
  bytes: number;
  updated_at: string;
  r2_key: string;
};

type SnapshotListItem = {
  bytes: number;
  etag: string;
  filename: string;
  updatedAt: string;
};

type SnapshotUpload =
  | {
      type: "ok";
      body: ReadableStream<Uint8Array> | ArrayBufferView;
      done: Promise<void> | null;
    }
  | { type: "error"; response: Response };

function snapshotsBucket(env: Env): R2Bucket | null {
  try {
    const bucket = env.SNAPSHOTS;
    if (bucket === undefined || bucket === null) {
      return null;
    }
    return bucket;
  } catch {
    return null;
  }
}

function snapshotHeaders(sql: SqlStorage, etag: string): Headers {
  const headers = new Headers();
  headers.set("ETag", etag);
  headers.set("X-Vibe-Prompt-Revision", String(objectRevision(sql)));
  return headers;
}

function snapshotEtag(object: R2Object): string {
  if (object.httpEtag !== "") {
    return object.httpEtag;
  }
  return `"${object.etag}"`;
}

function r2Misconfigured(): Response {
  return errorResponse(503, "misconfigured", SNAPSHOTS_MISCONFIGURED);
}

async function snapshotUploadBody(
  request: Request,
  encryption: VaultDocument["encryption"],
): Promise<SnapshotUpload> {
  if (encryption !== "required") {
    return { type: "ok", body: request.body ?? new Uint8Array(), done: null };
  }
  const prefixed = await takePrefix(request.body, 4);
  if (!hasVpbeMagic(prefixed.prefix)) {
    await prefixed.stream.cancel();
    return {
      type: "error",
      response: errorResponse(400, "invalid_magic", "Invalid magic."),
    };
  }
  const length = contentLengthOf(request);
  if (length === null) {
    const buffered = new Uint8Array(
      await new Response(prefixed.stream).arrayBuffer(),
    );
    return { type: "ok", body: buffered, done: null };
  }
  const fixed = toFixedLengthStream(prefixed.stream, length);
  return { type: "ok", body: fixed.readable, done: fixed.done };
}

function getSnapshotRow(sql: SqlStorage, filename: string): SnapshotRow | null {
  return one<SnapshotRow>(
    sql,
    `SELECT filename, etag, bytes, updated_at, r2_key
     FROM snapshots WHERE filename = ?`,
    filename,
  );
}

function upsertSnapshotRow(
  sql: SqlStorage,
  filename: string,
  etag: string,
  bytes: number,
  updatedAt: string,
  r2Key: string,
): void {
  sql.exec(
    `INSERT INTO snapshots (filename, etag, bytes, updated_at, r2_key)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(filename) DO UPDATE SET
       etag = excluded.etag,
       bytes = excluded.bytes,
       updated_at = excluded.updated_at,
       r2_key = excluded.r2_key`,
    filename,
    etag,
    bytes,
    updatedAt,
    r2Key,
  );
}

function listSnapshots(ctx: SnapshotContext): Response {
  if (ctx.loadVault() === null) {
    return errorResponse(404, "not_found", "Not Found");
  }
  const rows = all<SnapshotRow>(
    ctx.sql,
    `SELECT filename, etag, bytes, updated_at, r2_key
     FROM snapshots ORDER BY filename`,
  );
  const items: SnapshotListItem[] = rows.map((row) => ({
    bytes: row.bytes,
    etag: row.etag,
    filename: row.filename,
    updatedAt: row.updated_at,
  }));
  const document = {
    items,
    schema: SNAPSHOTS_SCHEMA,
  };
  return jsonResponse(sortKeys(document), 200, {
    "X-Vibe-Prompt-Revision": String(objectRevision(ctx.sql)),
  });
}

async function getSnapshot(
  ctx: SnapshotContext,
  bucket: R2Bucket,
  filename: string,
): Promise<Response> {
  const row = getSnapshotRow(ctx.sql, filename);
  if (row === null) {
    return errorResponse(404, "not_found", "Not Found");
  }
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(row.r2_key);
  } catch {
    return r2Misconfigured();
  }
  if (object === null) {
    return errorResponse(404, "not_found", "Not Found");
  }
  const headers = snapshotHeaders(ctx.sql, row.etag);
  headers.set("content-type", "application/octet-stream");
  return new Response(object.body, { status: 200, headers });
}

async function putSnapshot(
  ctx: SnapshotContext,
  request: Request,
  bucket: R2Bucket,
  snapshot: ParsedSnapshotItem,
): Promise<Response> {
  const vault = ctx.loadVault();
  if (vault === null) {
    return errorResponse(404, "not_found", "Not Found");
  }
  const current = getSnapshotRow(ctx.sql, snapshot.filename);
  const pre = evaluatePreconditions(
    current !== null,
    current?.etag ?? null,
    null,
    request,
  );
  if (pre.type === "error") {
    return pre.response;
  }

  const upload = await snapshotUploadBody(request, vault.document.encryption);
  if (upload.type === "error") {
    return upload.response;
  }

  const r2Key = `${vault.document.vaultId}/${snapshot.filename}`;
  let stored: R2Object | null;
  try {
    stored = await bucket.put(r2Key, upload.body);
    if (upload.done !== null) {
      await upload.done;
    }
  } catch {
    if (upload.done !== null) {
      await upload.done.catch(() => undefined);
    }
    return r2Misconfigured();
  }
  if (stored === null) {
    return r2Misconfigured();
  }

  const now = formatCanonicalUtc();
  const etag = snapshotEtag(stored);
  upsertSnapshotRow(ctx.sql, snapshot.filename, etag, stored.size, now, r2Key);
  if (snapshot.kind === "auto") {
    await gcAutoSnapshots(ctx.sql, bucket, vault.document.snapshotRetention);
  }
  return new Response(null, {
    status: pre.mode === "create" ? 201 : 204,
    headers: snapshotHeaders(ctx.sql, etag),
  });
}

async function deleteSnapshot(
  ctx: SnapshotContext,
  request: Request,
  bucket: R2Bucket,
  filename: string,
): Promise<Response> {
  const current = getSnapshotRow(ctx.sql, filename);
  const pre = evaluateIfMatch(
    current !== null,
    current?.etag ?? null,
    null,
    request,
  );
  if (pre.type === "error") {
    return pre.response;
  }
  if (current === null) {
    return errorResponse(404, "not_found", "Not Found");
  }
  try {
    await bucket.delete(current.r2_key);
  } catch {
    return r2Misconfigured();
  }
  ctx.sql.exec("DELETE FROM snapshots WHERE filename = ?", filename);
  return new Response(null, {
    status: 204,
    headers: snapshotHeaders(ctx.sql, current.etag),
  });
}

async function gcAutoSnapshots(
  sql: SqlStorage,
  bucket: R2Bucket,
  retention: VaultDocument["snapshotRetention"],
): Promise<void> {
  const autos = all<SnapshotRow>(
    sql,
    `SELECT filename, etag, bytes, updated_at, r2_key FROM snapshots
     WHERE filename LIKE 'vibe-prompt-auto_%'
     ORDER BY filename ASC`,
  );
  let count = autos.length;
  let totalBytes = 0;
  for (const row of autos) {
    totalBytes += row.bytes;
  }
  for (const victim of autos) {
    if (count <= retention.maxCount && totalBytes <= retention.maxBytes) {
      break;
    }
    try {
      await bucket.delete(victim.r2_key);
    } catch {
      // Unreferenced R2 keys may be ignored; SQL remains source of truth.
    }
    sql.exec("DELETE FROM snapshots WHERE filename = ?", victim.filename);
    count -= 1;
    totalBytes -= victim.bytes;
  }
}

export async function routeSnapshot(
  ctx: SnapshotContext,
  request: Request,
  snapshot: ParsedSnapshot,
): Promise<Response> {
  const bucket = snapshotsBucket(ctx.env);
  if (bucket === null) {
    return r2Misconfigured();
  }
  if (snapshot.type === "list") {
    if (request.method === "GET") {
      return listSnapshots(ctx);
    }
    return errorResponse(405, "method_not_allowed", "Method Not Allowed");
  }
  if (request.method === "GET") {
    return await getSnapshot(ctx, bucket, snapshot.filename);
  }
  if (request.method === "PUT") {
    return await putSnapshot(ctx, request, bucket, snapshot);
  }
  if (request.method === "DELETE") {
    return await deleteSnapshot(ctx, request, bucket, snapshot.filename);
  }
  return errorResponse(405, "method_not_allowed", "Method Not Allowed");
}
