import { DurableObject } from "cloudflare:workers";

import { canonicalJson, formatCanonicalUtc, sortKeys } from "./canonical";
import {
  emptyRevisionResponse,
  errorResponse,
  jsonResponse,
  quoteEtag,
  revisionHeaders,
} from "./http";
import {
  indexWouldExceedLimit,
  MAX_BATCH_DECODED_BYTES,
  MAX_BATCH_ITEMS,
  MAX_OBJECT_BYTES,
} from "./limits";
import { hasVpbeMagic } from "./magic";
import { parseObjectPath, type ParsedObject } from "./paths";
import { evaluateIfMatch, evaluatePreconditions } from "./preconditions";
import { decodeBase64, parsePushItems, pushItemPath, type PushItem } from "./push";
import {
  parseRateWindow,
  RATE_LIMIT_META_KEY,
  serializeRateWindow,
  tryConsumeObjects,
} from "./rate-limit";
import {
  parseTombstoneJson,
  parseVaultJson,
  type TombstoneDocument,
  type VaultDocument,
} from "./validate";

const META_VAULT_JSON = "vault_json";
const META_VAULT_REVISION = "vault_revision";
const META_OBJECT_REVISION = "object_revision";
const META_INDEX_UPDATED_AT = "index_updated_at";
const INDEX_SCHEMA = "vibe-prompt.index/1";
const ZERO_TIME = "1970-01-01T00:00:00.000Z";

type BlobRow = {
  path: string;
  etag: string;
  revision: number;
  bytes: number;
  updated_at: string;
  body: ArrayBuffer;
};

type IndexKind = "prompt" | "label" | "scope" | "tombstone";

type IndexItem = {
  bytes: number;
  deleted: boolean;
  etag: string;
  id: string;
  kind: IndexKind;
  revision: number;
  updatedAt: string;
};

type IndexDocument = {
  items: IndexItem[];
  revision: number;
  schema: typeof INDEX_SCHEMA;
  updatedAt: string;
};

export class VaultObject extends DurableObject<Env> {
  private queue: Promise<unknown>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.queue = Promise.resolve();
    this.ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
    });
  }

  fetch(request: Request): Promise<Response> {
    const result = this.queue.then(() => this.handleRequest(request));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private initSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS blobs (
        path TEXT PRIMARY KEY,
        etag TEXT NOT NULL,
        revision INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        body BLOB NOT NULL CHECK (length(body) <= 1500000)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      )
    `);
  }

  private async handleRequest(request: Request): Promise<Response> {
    try {
      this.initSchema();
      return await this.route(request);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return errorResponse(400, "invalid_json", "Invalid JSON.");
      }
      throw error;
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/v1/vault") {
      if (request.method === "GET") {
        return this.getVault();
      }
      if (request.method === "PUT") {
        return await this.putVault(request);
      }
      return errorResponse(405, "method_not_allowed", "Method Not Allowed");
    }

    if (pathname === "/v1/index") {
      if (request.method === "GET") {
        return this.getIndex(url);
      }
      return errorResponse(405, "method_not_allowed", "Method Not Allowed");
    }

    if (pathname === "/v1/sync/push") {
      if (request.method === "POST") {
        return await this.pushBatch(request);
      }
      return errorResponse(405, "method_not_allowed", "Method Not Allowed");
    }

    const parsed = parseObjectPath(pathname);
    if (!parsed.ok && parsed.reason === "invalid_path") {
      return errorResponse(400, "invalid_path", "Invalid path.");
    }
    if (parsed.ok) {
      if (request.method === "GET") {
        return this.getObject(parsed.value);
      }
      if (request.method === "PUT") {
        return await this.putObject(request, parsed.value);
      }
      if (request.method === "DELETE") {
        return this.deleteObject(request, parsed.value);
      }
      return errorResponse(405, "method_not_allowed", "Method Not Allowed");
    }

    return errorResponse(404, "not_found", "Not Found");
  }

  private getMeta(key: string): string | null {
    const row = this.ctx.storage.sql.exec<{ v: string }>(
      "SELECT v FROM meta WHERE k = ?",
      key,
    ).toArray()[0];
    return row?.v ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      key,
      value,
    );
  }

  private objectRevision(): number {
    const raw = this.getMeta(META_OBJECT_REVISION);
    if (raw === null) {
      return 0;
    }
    return Number(raw);
  }

  private loadVault(): { document: VaultDocument; revision: number } | null {
    const raw = this.getMeta(META_VAULT_JSON);
    if (raw === null) {
      return null;
    }
    const document = parseVaultJson(JSON.parse(raw) as unknown);
    if (document === null) {
      return null;
    }
    const revision = Number(this.getMeta(META_VAULT_REVISION) ?? "0");
    return { document, revision };
  }

  private getVault(): Response {
    const vault = this.loadVault();
    if (vault === null) {
      return errorResponse(404, "not_found", "Not Found");
    }
    return jsonResponse(vault.document, 200, revisionHeaders(vault.revision));
  }

  private async putVault(request: Request): Promise<Response> {
    const current = this.loadVault();
    const pre = evaluatePreconditions(
      current !== null,
      current === null ? null : quoteEtag(current.revision),
      current?.revision ?? null,
      request,
    );
    if (pre.type === "error") {
      return pre.response;
    }

    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return errorResponse(400, "invalid_json", "Invalid JSON.");
    }
    const document = parseVaultJson(parsed);
    if (document === null) {
      return errorResponse(400, "invalid_json", "Invalid JSON.");
    }
    if (
      current !== null &&
      (document.vaultId !== current.document.vaultId ||
        document.kdfSalt !== current.document.kdfSalt)
    ) {
      return errorResponse(409, "conflict", "Conflict.", {
        currentEtag: quoteEtag(current.revision),
        currentRevision: current.revision,
      });
    }

    const now = formatCanonicalUtc();
    const revision = this.objectRevision() + 1;
    this.ctx.storage.transactionSync(() => {
      this.setMeta(META_VAULT_JSON, canonicalJson(document));
      this.setMeta(META_VAULT_REVISION, String(revision));
      this.setMeta(META_OBJECT_REVISION, String(revision));
      this.setMeta(META_INDEX_UPDATED_AT, now);
    });
    const status = pre.mode === "create" ? 201 : 204;
    return emptyRevisionResponse(status, revision);
  }

  private readBlobs(): BlobRow[] {
    return this.ctx.storage.sql.exec<BlobRow>(
      "SELECT path, etag, revision, bytes, updated_at, body FROM blobs",
    ).toArray();
  }

  private blobToItem(row: BlobRow): IndexItem | null {
    const prompt = /^objects\/prompts\/([^/]+)\.vpb$/.exec(row.path);
    if (prompt?.[1] !== undefined) {
      return this.liveItem("prompt", prompt[1], row);
    }
    const label = /^objects\/labels\/([^/]+)\.vpb$/.exec(row.path);
    if (label?.[1] !== undefined) {
      return this.liveItem("label", label[1], row);
    }
    const scope = /^objects\/scopes\/([^/]+)\.vpb$/.exec(row.path);
    if (scope?.[1] !== undefined) {
      return this.liveItem("scope", scope[1], row);
    }
    const tombstone =
      /^objects\/tombstones\/(prompt|label|scope)\/([^/]+)\.json$/.exec(row.path);
    if (tombstone?.[1] !== undefined && tombstone[2] !== undefined) {
      return {
        bytes: row.bytes,
        deleted: true,
        etag: row.etag,
        id: `${tombstone[1]}:${tombstone[2]}`,
        kind: "tombstone",
        revision: row.revision,
        updatedAt: row.updated_at,
      };
    }
    return null;
  }

  private liveItem(kind: "prompt" | "label" | "scope", id: string, row: BlobRow): IndexItem {
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

  private buildIndex(): IndexDocument {
    const items: IndexItem[] = [];
    for (const row of this.readBlobs()) {
      const item = this.blobToItem(row);
      if (item !== null) {
        items.push(item);
      }
    }
    items.sort((left, right) => {
      const kindOrder = left.kind.localeCompare(right.kind);
      if (kindOrder !== 0) {
        return kindOrder;
      }
      return left.id.localeCompare(right.id);
    });
    return {
      items,
      revision: this.objectRevision(),
      schema: INDEX_SCHEMA,
      updatedAt: this.getMeta(META_INDEX_UPDATED_AT) ?? ZERO_TIME,
    };
  }

  private getIndex(url: URL): Response {
    const rawSince = url.searchParams.get("sinceRevision");
    let sinceRevision = 0;
    if (rawSince !== null && rawSince !== "") {
      const parsed = Number(rawSince);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return errorResponse(400, "invalid_json", "Invalid JSON.");
      }
      sinceRevision = parsed;
    }
    const index = this.buildIndex();
    const filtered: IndexDocument = {
      ...index,
      items: index.items.filter((item) => item.revision > sinceRevision),
    };
    return jsonResponse(sortKeys(filtered), 200, revisionHeaders(index.revision));
  }

  private getBlob(path: string): BlobRow | null {
    const row = this.ctx.storage.sql.exec<BlobRow>(
      "SELECT path, etag, revision, bytes, updated_at, body FROM blobs WHERE path = ?",
      path,
    ).toArray()[0];
    return row ?? null;
  }

  private upsertBlob(
    path: string,
    etag: string,
    revision: number,
    body: ArrayBuffer,
    updatedAt: string,
  ): void {
    this.ctx.storage.sql.exec(
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

  private deleteBlob(path: string): void {
    this.ctx.storage.sql.exec("DELETE FROM blobs WHERE path = ?", path);
  }

  private utf8Bytes(text: string): ArrayBuffer {
    const bytes = new TextEncoder().encode(text);
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }

  private sortItems(items: IndexItem[]): IndexItem[] {
    return [...items].sort((left, right) => {
      const kindOrder = left.kind.localeCompare(right.kind);
      if (kindOrder !== 0) {
        return kindOrder;
      }
      return left.id.localeCompare(right.id);
    });
  }

  private wouldExceedIndex(dropIds: string[], next: IndexItem): boolean {
    const current = this.buildIndex();
    const drop = new Set(dropIds);
    const items = this.sortItems([
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

  private getObject(path: ParsedObject): Response {
    const row = this.getBlob(path.blobPath);
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

  private async pushBatch(request: Request): Promise<Response> {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return errorResponse(400, "invalid_json", "Invalid JSON.");
    }
    const items = parsePushItems(parsed);
    if (items === null) {
      return errorResponse(400, "invalid_json", "Invalid JSON.");
    }
    if (items.length > MAX_BATCH_ITEMS) {
      return errorResponse(413, "payload_too_large", "Payload too large.");
    }

    const decoded: Array<{ item: PushItem; body: Uint8Array }> = [];
    let decodedBytes = 0;
    for (const item of items) {
      const body = decodeBase64(item.bodyBase64);
      if (body === null) {
        return errorResponse(400, "invalid_json", "Invalid JSON.");
      }
      decodedBytes += body.byteLength;
      if (decodedBytes > MAX_BATCH_DECODED_BYTES) {
        return errorResponse(413, "payload_too_large", "Payload too large.");
      }
      decoded.push({ item, body });
    }

    if (decoded.length > 0 && !this.consumeObjectQuota(decoded.length)) {
      return errorResponse(429, "rate_limited", "Rate limited.");
    }

    const results: Array<Record<string, unknown>> = [];
    for (const entry of decoded) {
      results.push(await this.pushOne(entry.item, entry.body, request.url));
    }
    const revision = this.objectRevision();
    return jsonResponse({ revision, results }, 200, revisionHeaders(revision));
  }

  private consumeObjectQuota(count: number): boolean {
    const current = parseRateWindow(this.getMeta(RATE_LIMIT_META_KEY));
    const result = tryConsumeObjects(current, count, Date.now());
    this.setMeta(RATE_LIMIT_META_KEY, serializeRateWindow(result.window));
    return result.ok;
  }

  private async pushOne(
    item: PushItem,
    body: Uint8Array,
    baseUrl: string,
  ): Promise<Record<string, unknown>> {
    const pathname = pushItemPath(item);
    const parsed = parseObjectPath(pathname);
    if (!parsed.ok) {
      return { id: item.id, status: 400 };
    }
    const headers = new Headers();
    if (item.ifMatch !== null) {
      headers.set("If-Match", item.ifMatch);
    }
    if (item.ifNoneMatch !== null) {
      headers.set("If-None-Match", item.ifNoneMatch);
    }
    const inner = new Request(new URL(pathname, baseUrl), {
      method: "PUT",
      headers,
      body,
    });
    return await this.pushResult(item.id, await this.putObject(inner, parsed.value));
  }

  private async pushResult(
    id: string,
    response: Response,
  ): Promise<Record<string, unknown>> {
    const status = response.status;
    // Batch item success is 204 even when the inner PUT created with 201.
    if (status === 201 || status === 204) {
      const etag = response.headers.get("ETag");
      if (etag === null) {
        return { id, status: 204 };
      }
      return { id, status: 204, etag };
    }
    if (status === 409) {
      const payload = await response.json() as { currentEtag?: string | null };
      return { id, status, currentEtag: payload.currentEtag ?? null };
    }
    await response.body?.cancel();
    return { id, status };
  }

  private async putObject(request: Request, path: ParsedObject): Promise<Response> {
    if (path.type === "tombstone") {
      return await this.putTombstone(request, path);
    }
    return await this.putLive(request, path);
  }

  private async putLive(
    request: Request,
    path: Extract<ParsedObject, { type: "live" }>,
  ): Promise<Response> {
    const current = this.getBlob(path.blobPath);
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
    const encryption = this.loadVault()?.document.encryption ?? "required";
    if (encryption === "required" && !hasVpbeMagic(new Uint8Array(buffer))) {
      return errorResponse(400, "invalid_magic", "Invalid magic.");
    }

    const now = formatCanonicalUtc();
    const revision = this.objectRevision() + 1;
    const etag = quoteEtag(revision);
    const nextItem: IndexItem = {
      bytes: buffer.byteLength,
      deleted: false,
      etag,
      id: path.id,
      kind: path.indexKind,
      revision,
      updatedAt: now,
    };
    if (this.wouldExceedIndex([path.id, path.tombstoneIndexId], nextItem)) {
      return errorResponse(507, "index_too_large", "Index too large.");
    }

    this.ctx.storage.transactionSync(() => {
      this.upsertBlob(path.blobPath, etag, revision, buffer, now);
      this.deleteBlob(path.tombstoneBlobPath);
      this.setMeta(META_OBJECT_REVISION, String(revision));
      this.setMeta(META_INDEX_UPDATED_AT, now);
    });
    return emptyRevisionResponse(pre.mode === "create" ? 201 : 204, revision);
  }

  private async putTombstone(
    request: Request,
    path: Extract<ParsedObject, { type: "tombstone" }>,
  ): Promise<Response> {
    const current = this.getBlob(path.blobPath);
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

    const body = this.utf8Bytes(canonicalJson(document));
    if (body.byteLength > MAX_OBJECT_BYTES) {
      return errorResponse(413, "payload_too_large", "Payload too large.");
    }

    const now = formatCanonicalUtc();
    const revision = this.objectRevision() + 1;
    const etag = quoteEtag(revision);
    const nextItem: IndexItem = {
      bytes: body.byteLength,
      deleted: true,
      etag,
      id: path.indexId,
      kind: "tombstone",
      revision,
      updatedAt: now,
    };
    if (this.wouldExceedIndex([path.id, path.indexId], nextItem)) {
      return errorResponse(507, "index_too_large", "Index too large.");
    }

    this.ctx.storage.transactionSync(() => {
      this.upsertBlob(path.blobPath, etag, revision, body, now);
      this.deleteBlob(path.liveBlobPath);
      this.setMeta(META_OBJECT_REVISION, String(revision));
      this.setMeta(META_INDEX_UPDATED_AT, now);
    });
    return emptyRevisionResponse(pre.mode === "create" ? 201 : 204, revision);
  }

  private deleteObject(request: Request, path: ParsedObject): Response {
    if (path.type === "tombstone") {
      return this.deleteTombstone(request, path);
    }
    return this.deleteLive(request, path);
  }

  private deleteLive(
    request: Request,
    path: Extract<ParsedObject, { type: "live" }>,
  ): Response {
    const current = this.getBlob(path.blobPath);
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
    const revision = this.objectRevision() + 1;
    const etag = quoteEtag(revision);
    const document: TombstoneDocument = {
      schema: "vibe-prompt.tombstone/1",
      targetKind: path.indexKind,
      id: path.id,
      deletedAt: now,
    };
    const body = this.utf8Bytes(canonicalJson(document));
    const nextItem: IndexItem = {
      bytes: body.byteLength,
      deleted: true,
      etag,
      id: path.tombstoneIndexId,
      kind: "tombstone",
      revision,
      updatedAt: now,
    };
    if (this.wouldExceedIndex([path.id, path.tombstoneIndexId], nextItem)) {
      return errorResponse(507, "index_too_large", "Index too large.");
    }

    this.ctx.storage.transactionSync(() => {
      this.deleteBlob(path.blobPath);
      this.upsertBlob(path.tombstoneBlobPath, etag, revision, body, now);
      this.setMeta(META_OBJECT_REVISION, String(revision));
      this.setMeta(META_INDEX_UPDATED_AT, now);
    });
    return emptyRevisionResponse(204, revision);
  }

  private deleteTombstone(
    request: Request,
    path: Extract<ParsedObject, { type: "tombstone" }>,
  ): Response {
    const current = this.getBlob(path.blobPath);
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
    const revision = this.objectRevision() + 1;
    this.ctx.storage.transactionSync(() => {
      this.deleteBlob(path.blobPath);
      this.setMeta(META_OBJECT_REVISION, String(revision));
      this.setMeta(META_INDEX_UPDATED_AT, now);
    });
    return emptyRevisionResponse(204, revision);
  }
}
