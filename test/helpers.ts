import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";

import worker from "../src/index";

export const AUTH_VALUE = "test-secret";
export const TOKEN_SALT = "vibe-prompt-worker-v1";
export const PROTOCOL_HEADER = "X-Vibe-Prompt-Protocol";
export const VAULT_URL = "https://worker.test/v1/vault";
export const INDEX_URL = "https://worker.test/v1/index";
export const HEALTH_URL = "https://worker.test/v1/health";
export const PUSH_URL = "https://worker.test/v1/sync/push";
export const VAULT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const KDF_SALT = "0123456789abcdef0123456789abcdef";
export const PROMPT_ID = "11111111-2222-4333-8444-555555555555";
export const PROMPT_ID_2 = "22222222-3333-4444-8555-666666666666";

export function configuredEnv(authValue = AUTH_VALUE): Env {
  return { ...env, AUTH_VALUE: authValue };
}

export async function fetchConfigured(input: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(input, init), configuredEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function hexSha256Utf8(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function bearerToken(authValue = AUTH_VALUE): Promise<string> {
  return hexSha256Utf8(`${authValue}${TOKEN_SALT}`);
}

export async function authHeaders(extra?: HeadersInit): Promise<Headers> {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${await bearerToken()}`);
  return headers;
}

export async function writeHeaders(extra?: HeadersInit): Promise<Headers> {
  return authHeaders({ [PROTOCOL_HEADER]: "1", ...headerRecord(extra) });
}

function headerRecord(extra?: HeadersInit): Record<string, string> {
  if (extra === undefined) {
    return {};
  }
  return Object.fromEntries(new Headers(extra).entries());
}

export function vaultDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "vibe-prompt.vault/1",
    protocolVersion: 1,
    vaultId: VAULT_ID,
    encryption: "required",
    kdf: "vault-v1",
    kdfSalt: KDF_SALT,
    snapshotRetention: {
      maxCount: 30,
      maxBytes: 629145600,
    },
    ...overrides,
  };
}

export async function putVault(
  body: unknown,
  extra?: HeadersInit,
): Promise<Response> {
  const headers = await writeHeaders({
    "content-type": "application/json",
    ...headerRecord(extra),
  });
  if (!headers.has("If-Match") && !headers.has("If-None-Match")) {
    headers.set("If-None-Match", "*");
  }
  return fetchConfigured(VAULT_URL, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

export async function getVault(): Promise<Response> {
  return fetchConfigured(VAULT_URL, { headers: await authHeaders() });
}

export async function getIndex(sinceRevision?: number): Promise<Response> {
  const url = sinceRevision === undefined
    ? INDEX_URL
    : `${INDEX_URL}?sinceRevision=${sinceRevision}`;
  return fetchConfigured(url, { headers: await authHeaders() });
}

export function objectUrl(kind: string, id: string): string {
  return `https://worker.test/v1/objects/${kind}/${id}`;
}

export function tombstoneUrl(targetKind: string, id: string): string {
  return objectUrl("tombstones", encodeURIComponent(`${targetKind}:${id}`));
}

export function vpbeBody(fill = 0xab): Uint8Array {
  const body = new Uint8Array(16);
  body[0] = 86;
  body[1] = 80;
  body[2] = 66;
  body[3] = 69;
  body.fill(fill, 4);
  return body;
}

export function vpbpBody(): Uint8Array {
  const body = vpbeBody();
  body[3] = 80;
  return body;
}

export async function putObject(
  url: string,
  body: BodyInit,
  extra?: HeadersInit,
): Promise<Response> {
  const headers = await writeHeaders(extra);
  if (!headers.has("If-Match") && !headers.has("If-None-Match")) {
    headers.set("If-None-Match", "*");
  }
  return fetchConfigured(url, {
    method: "PUT",
    headers,
    body,
  });
}

export async function getObject(url: string): Promise<Response> {
  return fetchConfigured(url, { headers: await authHeaders() });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function pushItem(
  kind: string,
  id: string,
  body: Uint8Array,
  preconditions: { ifMatch?: string | null; ifNoneMatch?: string | null } = {},
): Record<string, unknown> {
  const ifMatch = typeof preconditions.ifMatch === "string" ? preconditions.ifMatch : null;
  const ifNoneMatch = preconditions.ifNoneMatch === undefined
    ? (ifMatch === null ? "*" : null)
    : preconditions.ifNoneMatch;
  return {
    kind,
    id,
    ifMatch,
    ifNoneMatch,
    bodyBase64: bytesToBase64(body),
  };
}

export async function pushObjects(items: unknown[]): Promise<Response> {
  return fetchConfigured(PUSH_URL, {
    method: "POST",
    headers: await writeHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ items }),
  });
}

export type PushResponse = {
  revision: number;
  results: Array<{
    id: string;
    status: number;
    etag?: string;
    currentEtag?: string | null;
  }>;
};

export async function deleteObject(url: string, extra?: HeadersInit): Promise<Response> {
  return fetchConfigured(url, {
    method: "DELETE",
    headers: await writeHeaders(extra),
  });
}

export function paddedUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export type ErrorBody = {
  error: { code: string; message: string };
  currentEtag?: string | null;
  currentRevision?: number | null;
};

export type IndexBody = {
  schema: string;
  revision: number;
  updatedAt: string;
  items: Array<{
    kind: string;
    id: string;
    revision: number;
    updatedAt: string;
    deleted: boolean;
    bytes: number;
    etag: string;
  }>;
};
