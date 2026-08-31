import { errorResponse, jsonResponse } from "./http";
import { hasVpbeMagic } from "./magic";

const HEAD_SCHEMA = "vibe-prompt.head/2";
const MANIFEST_KEY = "manifest.json";
const MANIFEST_SCHEMA = "vibe-prompt.manifest/2";
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

type ManifestItem = {
  name: string;
  size: number;
  createdAt: string;
  etag: string;
};

type ManifestDocument = {
  schema: typeof MANIFEST_SCHEMA;
  head: HeadDocument | null;
  snapshots: ManifestItem[];
  pendingDeletes: string[];
  retiredSnapshots: string[];
};

type ManifestState = {
  document: ManifestDocument;
  etag: string | null;
};

type ManifestLoadResult =
  | { type: "ok"; state: ManifestState }
  | { type: "error"; response: Response };

type SnapshotRoute =
  | { type: "list" }
  | { type: "item"; filename: string };

type ReadBodyResult =
  | { type: "ok"; body: Uint8Array }
  | { type: "too_large" }
  | { type: "error" };

type BodyStoreResult =
  | { type: "ok"; object: R2Object }
  | { type: "conflict" }
  | { type: "error"; response: Response };

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
  const loaded = await loadAndCleanManifest(bucket);
  if (loaded.type === "error") {
    return loaded.response;
  }
  const { head } = loaded.state.document;
  if (head === null) {
    return errorResponse(404, "not_found", "Not Found");
  }
  return jsonResponse(head, 200, manifestEtagHeaders(loaded.state));
}

async function putHead(request: Request, bucket: R2Bucket): Promise<Response> {
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
  if (read.type === "error") {
    return invalidBody();
  }
  const input = parseHeadInput(read.body);
  if (input === null) {
    return errorResponse(400, "invalid_json", "Invalid JSON.");
  }

  const loaded = await loadAndCleanManifest(bucket);
  if (loaded.type === "error") {
    return loaded.response;
  }
  const precondition = evaluateHeadPrecondition(request, loaded.state);
  if (precondition.type === "error") {
    return precondition.response;
  }
  if (!loaded.state.document.snapshots.some((item) => item.name === input.snapshot)) {
    return errorResponse(404, "snapshot_not_found", "Snapshot not found.");
  }

  const head: HeadDocument = {
    schema: HEAD_SCHEMA,
    snapshot: input.snapshot,
    updatedAt: new Date().toISOString(),
  };
  const next: ManifestDocument = { ...loaded.state.document, head };
  const stored = await storeManifest(bucket, loaded.state, next);
  if (stored.type === "error") {
    return stored.response;
  }
  if (stored.type === "conflict") {
    return preconditionFailed();
  }
  return jsonResponse(head, precondition.create ? 201 : 200, {
    ETag: httpEtag(stored.object),
  });
}

async function listSnapshots(bucket: R2Bucket): Promise<Response> {
  const loaded = await loadAndCleanManifest(bucket);
  if (loaded.type === "error") {
    return loaded.response;
  }
  const { document } = loaded.state;
  const items = [...document.snapshots]
    .sort(compareManifestItems)
    .map((item) => ({
      ...item,
      isHead: document.head?.snapshot === item.name,
    }));
  return jsonResponse(
    { schema: SNAPSHOTS_SCHEMA, items },
    200,
    manifestEtagHeaders(loaded.state),
  );
}

async function getSnapshot(bucket: R2Bucket, filename: string): Promise<Response> {
  const loaded = await loadAndCleanManifest(bucket);
  if (loaded.type === "error") {
    return loaded.response;
  }
  const item = loaded.state.document.snapshots.find((candidate) => candidate.name === filename);
  if (item === undefined) {
    return errorResponse(404, "not_found", "Not Found");
  }

  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(snapshotKey(filename));
  } catch {
    return storageUnavailable();
  }
  if (object === null || httpEtag(object) !== item.etag || object.size !== item.size) {
    return errorResponse(500, "invalid_storage", "Stored snapshot is invalid.");
  }
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Length": String(item.size),
      "Content-Type": SNAPSHOT_CONTENT_TYPE,
      ETag: item.etag,
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
  if (read.type === "error") {
    return invalidBody();
  }
  if (!hasVpbeMagic(read.body)) {
    return errorResponse(400, "invalid_magic", "Invalid magic.");
  }

  const loaded = await loadAndCleanManifest(bucket);
  if (loaded.type === "error") {
    return loaded.response;
  }
  if (loaded.state.document.snapshots.some((item) => item.name === filename)) {
    return preconditionFailed();
  }
  if (loaded.state.document.pendingDeletes.includes(filename)) {
    return errorResponse(409, "snapshot_deleting", "Snapshot deletion is pending.");
  }
  if (loaded.state.document.retiredSnapshots.includes(filename)) {
    return errorResponse(409, "snapshot_deleted", "Snapshot filename is retired.");
  }

  const body = await storeOrReuseBody(bucket, filename, read.body);
  if (body.type === "error") {
    return body.response;
  }
  if (body.type === "conflict") {
    return preconditionFailed();
  }
  const item: ManifestItem = {
    name: filename,
    size: body.object.size,
    createdAt: body.object.uploaded.toISOString(),
    etag: httpEtag(body.object),
  };
  const next: ManifestDocument = {
    ...loaded.state.document,
    snapshots: [...loaded.state.document.snapshots, item],
  };
  const stored = await storeManifest(bucket, loaded.state, next);
  if (stored.type === "error") {
    return stored.response;
  }
  if (stored.type === "conflict") {
    return preconditionFailed();
  }
  return new Response(null, {
    status: 201,
    headers: {
      ETag: item.etag,
      "X-Vibe-Prompt-Manifest-ETag": httpEtag(stored.object),
    },
  });
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
  const loaded = await loadAndCleanManifest(bucket);
  if (loaded.type === "error") {
    return loaded.response;
  }
  const item = loaded.state.document.snapshots.find((candidate) => candidate.name === filename);
  if (item === undefined) {
    return errorResponse(404, "not_found", "Not Found");
  }
  if (item.etag !== ifMatch) {
    return preconditionFailed();
  }
  if (loaded.state.document.head?.snapshot === filename) {
    return errorResponse(409, "snapshot_is_head", "Current snapshot cannot be deleted.");
  }

  const next: ManifestDocument = {
    ...loaded.state.document,
    snapshots: loaded.state.document.snapshots.filter(
      (candidate) => candidate.name !== filename,
    ),
    pendingDeletes: [...loaded.state.document.pendingDeletes, filename],
    retiredSnapshots: [...loaded.state.document.retiredSnapshots, filename],
  };
  const stored = await storeManifest(bucket, loaded.state, next);
  if (stored.type === "error") {
    return stored.response;
  }
  if (stored.type === "conflict") {
    return preconditionFailed();
  }

  await finishPendingDelete(
    bucket,
    { document: next, etag: stored.object.etag },
    filename,
  );
  return new Response(null, { status: 204, headers: { ETag: item.etag } });
}

async function loadAndCleanManifest(bucket: R2Bucket): Promise<ManifestLoadResult> {
  const loaded = await loadManifest(bucket);
  if (loaded.type === "error" || loaded.state.document.pendingDeletes.length === 0) {
    return loaded;
  }

  let state = loaded.state;
  for (const filename of [...state.document.pendingDeletes]) {
    const cleaned = await finishPendingDelete(bucket, state, filename);
    if (cleaned !== null) {
      state = cleaned;
    }
  }
  return { type: "ok", state };
}

async function finishPendingDelete(
  bucket: R2Bucket,
  state: ManifestState,
  filename: string,
): Promise<ManifestState | null> {
  try {
    await bucket.delete(snapshotKey(filename));
  } catch {
    return null;
  }
  const next: ManifestDocument = {
    ...state.document,
    pendingDeletes: state.document.pendingDeletes.filter((name) => name !== filename),
  };
  const stored = await storeManifest(bucket, state, next);
  if (stored.type !== "ok") {
    return null;
  }
  return { document: next, etag: stored.object.etag };
}

async function loadManifest(bucket: R2Bucket): Promise<ManifestLoadResult> {
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(MANIFEST_KEY);
  } catch {
    return { type: "error", response: storageUnavailable() };
  }
  if (object === null) {
    return { type: "ok", state: { document: emptyManifest(), etag: null } };
  }
  const document = await parseStoredManifest(object);
  if (document === null) {
    return {
      type: "error",
      response: errorResponse(500, "invalid_storage", "Stored manifest is invalid."),
    };
  }
  return { type: "ok", state: { document, etag: object.etag } };
}

async function storeManifest(
  bucket: R2Bucket,
  current: ManifestState,
  next: ManifestDocument,
): Promise<BodyStoreResult> {
  const onlyIf = current.etag === null
    ? new Headers({ "If-None-Match": "*" })
    : new Headers({ "If-Match": `"${current.etag}"` });
  let stored: R2Object | null;
  try {
    stored = await bucket.put(MANIFEST_KEY, JSON.stringify(next), {
      onlyIf,
      httpMetadata: { contentType: "application/json" },
    });
  } catch {
    return { type: "error", response: storageUnavailable() };
  }
  return stored === null ? { type: "conflict" } : { type: "ok", object: stored };
}

async function storeOrReuseBody(
  bucket: R2Bucket,
  filename: string,
  body: Uint8Array,
): Promise<BodyStoreResult> {
  let stored: R2Object | null;
  try {
    stored = await bucket.put(snapshotKey(filename), body, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: SNAPSHOT_CONTENT_TYPE },
    });
  } catch {
    return { type: "error", response: storageUnavailable() };
  }
  if (stored !== null) {
    return { type: "ok", object: stored };
  }

  let existing: R2ObjectBody | null;
  try {
    existing = await bucket.get(snapshotKey(filename));
  } catch {
    return { type: "error", response: storageUnavailable() };
  }
  if (existing === null) {
    return { type: "conflict" };
  }
  let existingBody: Uint8Array;
  try {
    existingBody = new Uint8Array(await existing.arrayBuffer());
  } catch {
    return { type: "error", response: storageUnavailable() };
  }
  if (!equalBytes(existingBody, body)) {
    return { type: "conflict" };
  }
  return { type: "ok", object: existing };
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

async function parseStoredManifest(object: R2ObjectBody): Promise<ManifestDocument | null> {
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
    candidate.schema !== MANIFEST_SCHEMA ||
    !Array.isArray(candidate.snapshots) ||
    !Array.isArray(candidate.pendingDeletes) ||
    !Array.isArray(candidate.retiredSnapshots)
  ) {
    return null;
  }
  const snapshots = parseManifestItems(candidate.snapshots);
  const pendingDeletes = parsePendingDeletes(candidate.pendingDeletes);
  const retiredSnapshots = parsePendingDeletes(candidate.retiredSnapshots);
  if (snapshots === null || pendingDeletes === null || retiredSnapshots === null) {
    return null;
  }
  const names = new Set(snapshots.map((item) => item.name));
  if (pendingDeletes.some((name) => names.has(name))) {
    return null;
  }
  const retired = new Set(retiredSnapshots);
  if (
    retiredSnapshots.some((name) => names.has(name)) ||
    pendingDeletes.some((name) => !retired.has(name))
  ) {
    return null;
  }
  const head = parseHeadDocument(candidate.head);
  if (head === undefined || (head !== null && !names.has(head.snapshot))) {
    return null;
  }
  return {
    schema: MANIFEST_SCHEMA,
    head,
    snapshots,
    pendingDeletes,
    retiredSnapshots,
  };
}

function parseManifestItems(value: unknown[]): ManifestItem[] | null {
  const items: ManifestItem[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }
    const item = raw as Record<string, unknown>;
    if (
      typeof item.name !== "string" ||
      !SNAPSHOT_FILENAME_RE.test(item.name) ||
      names.has(item.name) ||
      typeof item.size !== "number" ||
      !Number.isSafeInteger(item.size) ||
      item.size < 4 ||
      item.size > MAX_SNAPSHOT_BYTES ||
      typeof item.createdAt !== "string" ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      typeof item.etag !== "string" ||
      !isQuotedEtag(item.etag)
    ) {
      return null;
    }
    names.add(item.name);
    items.push({
      name: item.name,
      size: item.size,
      createdAt: item.createdAt,
      etag: item.etag,
    });
  }
  return items;
}

function parsePendingDeletes(value: unknown[]): string[] | null {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string" || !SNAPSHOT_FILENAME_RE.test(raw) || seen.has(raw)) {
      return null;
    }
    seen.add(raw);
    names.push(raw);
  }
  return names;
}

function parseHeadDocument(value: unknown): HeadDocument | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const head = value as Record<string, unknown>;
  if (
    head.schema !== HEAD_SCHEMA ||
    typeof head.snapshot !== "string" ||
    !SNAPSHOT_FILENAME_RE.test(head.snapshot) ||
    typeof head.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(head.updatedAt))
  ) {
    return undefined;
  }
  return {
    schema: HEAD_SCHEMA,
    snapshot: head.snapshot,
    updatedAt: head.updatedAt,
  };
}

async function readBodyAtMost(request: Request, maximum: number): Promise<ReadBodyResult> {
  if (request.body === null) {
    return { type: "ok", body: new Uint8Array() };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch {
      await cancelReader(reader);
      return { type: "error" };
    }
    if (next.done) {
      break;
    }
    const chunk = next.value instanceof Uint8Array
      ? next.value
      : new Uint8Array(next.value);
    total += chunk.byteLength;
    if (total > maximum) {
      await cancelReader(reader);
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

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The response remains deterministic even when the request stream cannot be cancelled.
  }
}

function evaluateHeadPrecondition(
  request: Request,
  state: ManifestState,
): { type: "ok"; create: boolean } | { type: "error"; response: Response } {
  const ifMatch = request.headers.get("If-Match");
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch === "*" && ifMatch === null) {
    return state.document.head === null
      ? { type: "ok", create: true }
      : { type: "error", response: preconditionFailed() };
  }
  if (ifMatch !== null && ifMatch !== "" && ifNoneMatch === null) {
    if (state.etag === null || ifMatch !== `"${state.etag}"`) {
      return { type: "error", response: preconditionFailed() };
    }
    return { type: "ok", create: false };
  }
  return { type: "error", response: preconditionRequired() };
}

function emptyManifest(): ManifestDocument {
  return {
    schema: MANIFEST_SCHEMA,
    head: null,
    snapshots: [],
    pendingDeletes: [],
    retiredSnapshots: [],
  };
}

function compareManifestItems(left: ManifestItem, right: ManifestItem): number {
  const byDate = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  return byDate === 0 ? right.name.localeCompare(left.name) : byDate;
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

function manifestEtagHeaders(state: ManifestState): HeadersInit | undefined {
  return state.etag === null ? undefined : { ETag: `"${state.etag}"` };
}

function httpEtag(object: R2Object): string {
  return object.httpEtag === "" ? `"${object.etag}"` : object.httpEtag;
}

function isQuotedEtag(value: string): boolean {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function invalidBody(): Response {
  return errorResponse(400, "invalid_body", "Request body could not be read.");
}

function preconditionRequired(): Response {
  return errorResponse(
    428,
    "precondition_required",
    "If-Match or If-None-Match is required.",
  );
}

function preconditionFailed(): Response {
  return errorResponse(412, "precondition_failed", "Precondition failed.");
}

function storageUnavailable(): Response {
  return errorResponse(503, "storage_unavailable", "R2 storage is unavailable.");
}
