import { DurableObject } from "cloudflare:workers";

import { canonicalJson, formatCanonicalUtc, sortKeys } from "./canonical";
import {
  emptyRevisionResponse,
  errorResponse,
  jsonResponse,
  quoteEtag,
  revisionHeaders,
} from "./http";
import { buildIndex, type IndexDocument } from "./index-doc";
import {
  MAX_BATCH_DECODED_BYTES,
  MAX_BATCH_ITEMS,
  MAX_OBJECT_BYTES,
} from "./limits";
import {
  deleteObject,
  getObject,
  putObject,
  type ObjectWriteContext,
} from "./object-write";
import { parseObjectPath, parseSnapshotPath } from "./paths";
import { evaluatePreconditions } from "./preconditions";
import { decodeBase64, parsePushItems, pushItemPath, type PushItem } from "./push";
import {
  parseRateWindow,
  RATE_LIMIT_META_KEY,
  serializeRateWindow,
  tryConsumeObjects,
} from "./rate-limit";
import { routeSnapshot, type SnapshotContext } from "./snapshots";
import {
  META_INDEX_UPDATED_AT,
  META_OBJECT_REVISION,
  META_VAULT_JSON,
  META_VAULT_REVISION,
  getMeta,
  objectRevision,
  setMeta,
} from "./sql";
import { parseVaultJson, type VaultDocument } from "./validate";

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
        body BLOB NOT NULL CHECK (length(body) <= ${MAX_OBJECT_BYTES})
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        filename TEXT PRIMARY KEY,
        etag TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        r2_key TEXT NOT NULL
      )
    `);
  }

  private async handleRequest(request: Request): Promise<Response> {
    try {
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

    const snapshot = parseSnapshotPath(pathname);
    if (!snapshot.ok && snapshot.reason === "invalid_path") {
      return errorResponse(400, "invalid_path", "Invalid path.");
    }
    if (snapshot.ok) {
      return await routeSnapshot(this.snapshotContext(), request, snapshot.value);
    }

    const parsed = parseObjectPath(pathname);
    if (!parsed.ok && parsed.reason === "invalid_path") {
      return errorResponse(400, "invalid_path", "Invalid path.");
    }
    if (parsed.ok) {
      if (request.method === "GET") {
        return getObject(this.ctx.storage.sql, parsed.value);
      }
      if (request.method === "PUT") {
        return await putObject(this.objectWriteContext(), request, parsed.value);
      }
      if (request.method === "DELETE") {
        return deleteObject(this.objectWriteContext(), request, parsed.value);
      }
      return errorResponse(405, "method_not_allowed", "Method Not Allowed");
    }

    return errorResponse(404, "not_found", "Not Found");
  }

  private objectWriteContext(): ObjectWriteContext {
    return {
      sql: this.ctx.storage.sql,
      transactionSync: (closure) => this.ctx.storage.transactionSync(closure),
      loadVault: () => this.loadVault(),
    };
  }

  private snapshotContext(): SnapshotContext {
    return {
      sql: this.ctx.storage.sql,
      env: this.env,
      loadVault: () => this.loadVault(),
    };
  }

  private loadVault(): { document: VaultDocument; revision: number } | null {
    const raw = getMeta(this.ctx.storage.sql, META_VAULT_JSON);
    if (raw === null) {
      return null;
    }
    const document = parseVaultJson(JSON.parse(raw) as unknown);
    if (document === null) {
      return null;
    }
    const revision = Number(
      getMeta(this.ctx.storage.sql, META_VAULT_REVISION) ?? "0",
    );
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
    const revision = objectRevision(this.ctx.storage.sql) + 1;
    this.ctx.storage.transactionSync(() => {
      setMeta(this.ctx.storage.sql, META_VAULT_JSON, canonicalJson(document));
      setMeta(this.ctx.storage.sql, META_VAULT_REVISION, String(revision));
      setMeta(this.ctx.storage.sql, META_OBJECT_REVISION, String(revision));
      setMeta(this.ctx.storage.sql, META_INDEX_UPDATED_AT, now);
    });
    const status = pre.mode === "create" ? 201 : 204;
    return emptyRevisionResponse(status, revision);
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
    const index = buildIndex(this.ctx.storage.sql);
    const filtered: IndexDocument = {
      ...index,
      items: index.items.filter((item) => item.revision > sinceRevision),
    };
    return jsonResponse(sortKeys(filtered), 200, revisionHeaders(index.revision));
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
    const revision = objectRevision(this.ctx.storage.sql);
    return jsonResponse({ revision, results }, 200, revisionHeaders(revision));
  }

  private consumeObjectQuota(count: number): boolean {
    const current = parseRateWindow(
      getMeta(this.ctx.storage.sql, RATE_LIMIT_META_KEY),
    );
    const result = tryConsumeObjects(current, count, Date.now());
    setMeta(
      this.ctx.storage.sql,
      RATE_LIMIT_META_KEY,
      serializeRateWindow(result.window),
    );
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
    return await this.pushResult(
      item.id,
      await putObject(this.objectWriteContext(), inner, parsed.value),
    );
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
}
