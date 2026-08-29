import { DurableObject } from "cloudflare:workers";

import { canonicalJson, formatCanonicalUtc, sortKeys } from "./canonical";
import {
  emptyRevisionResponse,
  errorResponse,
  jsonResponse,
  quoteEtag,
  revisionHeaders,
} from "./http";
import { evaluatePreconditions } from "./preconditions";
import { parseVaultJson, type VaultDocument } from "./validate";

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
}
