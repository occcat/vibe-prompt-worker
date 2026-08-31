import { errorResponse, jsonResponse } from "./http";
import { hasVpbeMagic } from "./magic";

const HEAD_KEY = "head.json";
const HEAD_SCHEMA = "vibe-prompt.head/2";
const SNAPSHOT_CONTENT_TYPE = "application/octet-stream";
const SNAPSHOT_PREFIX = "snapshots/";
const SNAPSHOTS_SCHEMA = "vibe-prompt.snapshots/2";
const MAX_HEAD_BYTES = 16 * 1024;
export const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;

const SNAPSHOT_FILENAME_RE =
  /^vibe-prompt-(auto|backup)_(\d{8}T\d{6}Z)_([0-9a-f]{8})_([0-9a-f]{6})\.vpb$/;

type HeadDocument = {
  schema: typeof HEAD_SCHEMA;
  snapshot: string;
  updatedAt: string;
};

type HeadInput = {
  schema: typeof HEAD_SCHEMA;
  snapshot: string;
};

type SnapshotRoute =
  | { type: "list" }
  | { type: "item"; filename: string };

type ReadBodyResult =
  | { type: "ok"; body: Uint8Array }
  | { type: "too_large" };

export async function routeSnapshotApi(
  request: Request,
  bucket: R2Bucket,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/v2/head") {
    return await routeHead(request, bucket);
  }

  const parsed = parseSnapshotRoute(pathname);
  if (parsed === null) {
    if (pathname === "/v2/snapshots" || pathname.startsWith("/v2/snapshots/")) {
      return errorResponse(400, "invalid_path", "Invalid path.");
    }
    return null;
  }
  if (parsed.type === "list") {
    if (request.method !== "GET") {
      return errorResponse(405, "method_not_allowed", "Method Not Allowed");
    }
    return await listSnapshots(bucket);
  }

  if (request.method === "GET") {
    return await getSnapshot(bucket, parsed.filename);
  }
  if (request.method === "PUT") {
    return await putSnapshot(request, bucket, parsed.filename);
  }
  if (request.method === "DELETE") {
    return await deleteSnapshot(request, bucket, parsed.filename);
  }
  return errorResponse(405, "method_not_allowed", "Method Not Allowed");
}

async function routeHead(request: Request, bucket: R2Bucket): Promise<Response> {
  if (request.method === "GET") {
    return await getHead(bucket);
  }
  if (request.method === "PUT") {
    return await putHead(request, bucket);
  }
  return errorResponse(405, "method_not_allowed", "Method Not Allowed");
}

async function getHead(bucket: R2Bucket): Promise<Response> {
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(HEAD_KEY);
  } catch {
    return storageUnavailable();
  }
  if (object === null) {
    return errorResponse(404, "not_found", "Not Found");
  }
  const document = await parseStoredHead(object);
  if (document === null) {
    return errorResponse(500, "invalid_storage", "Stored head is invalid.");
  }
  return jsonResponse(document, 200, { ETag: httpEtag(object) });
}

async function putHead(request: Request, bucket: R2Bucket): Promise<Response> {
  const condition = headWriteCondition(request);
  if (condition === null) {
    return preconditionRequired();
  }
  if (!hasContentType(request, "application/json")) {
    return errorResponse(
      415,
      "invalid_content_type",
      "Content-Type must be application/json.",
    );
  }
  const read = await readBodyAtMost(request, MAX_HEAD_BYTES);
  if (read.type === "too_large") {
    return errorResponse(413, "payload_too_large", "Payload too large.");
  }
  const input = parseHeadInput(read.body);
  if (input === null) {
    return errorResponse(400, "invalid_json", "Invalid JSON.");
  }

  let snapshot: R2Object | null;
  try {
    snapshot = await bucket.head(snapshotKey(input.snapshot));
  } catch {
    return storageUnavailable();
  }
  if (snapshot === null) {
    return errorResponse(404, "snapshot_not_found", "Snapshot not found.");
  }

  const document: HeadDocument = {
    schema: HEAD_SCHEMA,
    snapshot: input.snapshot,
    updatedAt: new Date().toISOString(),
  };
  let stored: R2Object | null;
  try {
    stored = await bucket.put(HEAD_KEY, JSON.stringify(document), {
      onlyIf: condition.headers,
      httpMetadata: { contentType: "application/json" },
    });
  } catch {
    return storageUnavailable();
  }
  if (stored === null) {
    return errorResponse(412, "precondition_failed", "Precondition failed.");
  }
  return jsonResponse(document, condition.create ? 201 : 200, {
    ETag: httpEtag(stored),
  });
}

async function listSnapshots(bucket: R2Bucket): Promise<Response> {
  let objects: R2Object[];
  try {
    objects = await listAll(bucket, SNAPSHOT_PREFIX);
  } catch {
    return storageUnavailable();
  }
  const head = await loadHead(bucket);
  if (head.type === "error") {
    return head.response;
  }
  objects.sort((left, right) => {
    const byDate = right.uploaded.getTime() - left.uploaded.getTime();
    return byDate === 0 ? right.key.localeCompare(left.key) : byDate;
  });
  return jsonResponse({
    schema: SNAPSHOTS_SCHEMA,
    items: objects.map((object) => {
      const name = object.key.slice(SNAPSHOT_PREFIX.length);
      return {
        name,
        size: object.size,
        createdAt: object.uploaded.toISOString(),
        etag: httpEtag(object),
        isHead: head.document?.snapshot === name,
      };
    }),
  });
}

async function getSnapshot(bucket: R2Bucket, filename: string): Promise<Response> {
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(snapshotKey(filename));
  } catch {
    return storageUnavailable();
  }
  if (object === null) {
    return errorResponse(404, "not_found", "Not Found");
  }
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Length": String(object.size),
      "Content-Type": SNAPSHOT_CONTENT_TYPE,
      ETag: httpEtag(object),
    },
  });
}

async function putSnapshot(
  request: Request,
  bucket: R2Bucket,
  filename: string,
): Promise<Response> {
  if (
    request.headers.get("If-None-Match") !== "*" ||
    request.headers.has("If-Match")
  ) {
    return preconditionRequired();
  }
  if (!hasContentType(request, SNAPSHOT_CONTENT_TYPE)) {
    return errorResponse(
      415,
      "invalid_content_type",
      `Content-Type must be ${SNAPSHOT_CONTENT_TYPE}.`,
    );
  }
  const declaredLength = contentLength(request);
  if (declaredLength !== null && declaredLength > MAX_SNAPSHOT_BYTES) {
    return errorResponse(413, "payload_too_large", "Payload too large.");
  }
  const read = await readBodyAtMost(request, MAX_SNAPSHOT_BYTES);
  if (read.type === "too_large") {
    return errorResponse(413, "payload_too_large", "Payload too large.");
  }
  if (!hasVpbeMagic(read.body)) {
    return errorResponse(400, "invalid_magic", "Invalid magic.");
  }

  let stored: R2Object | null;
  try {
    stored = await bucket.put(snapshotKey(filename), read.body, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: SNAPSHOT_CONTENT_TYPE },
    });
  } catch {
    return storageUnavailable();
  }
  if (stored === null) {
    return errorResponse(412, "precondition_failed", "Precondition failed.");
  }
  return new Response(null, { status: 201, headers: { ETag: httpEtag(stored) } });
}

async function deleteSnapshot(
  request: Request,
  bucket: R2Bucket,
  filename: string,
): Promise<Response> {
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch === null || ifMatch === "") {
    return preconditionRequired();
  }

  let object: R2Object | null;
  try {
    object = await bucket.head(snapshotKey(filename));
  } catch {
    return storageUnavailable();
  }
  if (object === null) {
    return errorResponse(404, "not_found", "Not Found");
  }
  if (httpEtag(object) !== ifMatch) {
    return errorResponse(412, "precondition_failed", "Precondition failed.");
  }

  const head = await loadHead(bucket);
  if (head.type === "error") {
    return head.response;
  }
  if (head.document?.snapshot === filename) {
    return errorResponse(409, "snapshot_is_head", "Current snapshot cannot be deleted.");
  }

  try {
    await bucket.delete(snapshotKey(filename));
  } catch {
    return storageUnavailable();
  }
  return new Response(null, { status: 204, headers: { ETag: httpEtag(object) } });
}

function parseSnapshotRoute(pathname: string): SnapshotRoute | null {
  if (pathname === "/v2/snapshots") {
    return { type: "list" };
  }
  const prefix = "/v2/snapshots/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const encoded = pathname.slice(prefix.length);
  if (encoded === "" || encoded.includes("/") || encoded.includes("\\")) {
    return null;
  }
  let filename: string;
  try {
    filename = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (!SNAPSHOT_FILENAME_RE.test(filename)) {
    return null;
  }
  return { type: "item", filename };
}

function parseHeadInput(bytes: Uint8Array): HeadInput | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== HEAD_SCHEMA || typeof candidate.snapshot !== "string") {
    return null;
  }
  if (!SNAPSHOT_FILENAME_RE.test(candidate.snapshot)) {
    return null;
  }
  return { schema: HEAD_SCHEMA, snapshot: candidate.snapshot };
}

async function parseStoredHead(object: R2ObjectBody): Promise<HeadDocument | null> {
  let value: unknown;
  try {
    value = await object.json();
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schema !== HEAD_SCHEMA ||
    typeof candidate.snapshot !== "string" ||
    !SNAPSHOT_FILENAME_RE.test(candidate.snapshot) ||
    typeof candidate.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.updatedAt))
  ) {
    return null;
  }
  return {
    schema: HEAD_SCHEMA,
    snapshot: candidate.snapshot,
    updatedAt: candidate.updatedAt,
  };
}

async function loadHead(
  bucket: R2Bucket,
): Promise<{ type: "ok"; document: HeadDocument | null } | { type: "error"; response: Response }> {
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(HEAD_KEY);
  } catch {
    return { type: "error", response: storageUnavailable() };
  }
  if (object === null) {
    return { type: "ok", document: null };
  }
  const document = await parseStoredHead(object);
  if (document === null) {
    return {
      type: "error",
      response: errorResponse(500, "invalid_storage", "Stored head is invalid."),
    };
  }
  return { type: "ok", document };
}

async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return objects;
}

async function readBodyAtMost(request: Request, maximum: number): Promise<ReadBodyResult> {
  if (request.body === null) {
    return { type: "ok", body: new Uint8Array() };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    const chunk = next.value instanceof Uint8Array
      ? next.value
      : new Uint8Array(next.value);
    total += chunk.byteLength;
    if (total > maximum) {
      await reader.cancel();
      return { type: "too_large" };
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { type: "ok", body };
}

function headWriteCondition(
  request: Request,
): { headers: Headers; create: boolean } | null {
  const ifMatch = request.headers.get("If-Match");
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifMatch !== null && ifMatch !== "" && ifNoneMatch === null) {
    return { headers: new Headers({ "If-Match": ifMatch }), create: false };
  }
  if (ifNoneMatch === "*" && ifMatch === null) {
    return { headers: new Headers({ "If-None-Match": "*" }), create: true };
  }
  return null;
}

function contentLength(request: Request): number | null {
  const value = request.headers.get("Content-Length");
  if (value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function hasContentType(request: Request, expected: string): boolean {
  return request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

function snapshotKey(filename: string): string {
  return `${SNAPSHOT_PREFIX}${filename}`;
}

function httpEtag(object: R2Object): string {
  return object.httpEtag === "" ? `"${object.etag}"` : object.httpEtag;
}

function preconditionRequired(): Response {
  return errorResponse(
    428,
    "precondition_required",
    "If-Match or If-None-Match is required.",
  );
}

function storageUnavailable(): Response {
  return errorResponse(503, "storage_unavailable", "R2 storage is unavailable.");
}
