import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";

import worker from "../src/index";

export const AUTH_VALUE = "test-secret";
export const TOKEN_SALT = "vibe-prompt-worker-v1";
export const PROTOCOL_HEADER = "X-Vibe-Prompt-Protocol";
export const V2_HEALTH_URL = "https://worker.test/v2/health";
export const V2_HEAD_URL = "https://worker.test/v2/head";
export const V2_SNAPSHOTS_URL = "https://worker.test/v2/snapshots";

export function configuredEnv(authValue = AUTH_VALUE): Env {
  return { ...env, AUTH_VALUE: authValue };
}

export async function fetchConfigured(input: string, init?: RequestInit): Promise<Response> {
  return fetchWithEnv(configuredEnv(), input, init);
}

export async function fetchWithEnv(
  workerEnv: Env,
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(input, init), workerEnv, ctx);
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

export async function v2WriteHeaders(extra?: HeadersInit): Promise<Headers> {
  return authHeaders({ [PROTOCOL_HEADER]: "2", ...headerRecord(extra) });
}

function headerRecord(extra?: HeadersInit): Record<string, string> {
  return extra === undefined ? {} : Object.fromEntries(new Headers(extra).entries());
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

export function snapshotFilename(kind: "auto" | "backup", seq: number): string {
  const utc = `20260829T${seq.toString().padStart(6, "0")}Z`;
  const device = "aaaaaaaa";
  const rand = seq.toString(16).padStart(6, "0");
  return `vibe-prompt-${kind}_${utc}_${device}_${rand}.vpb`;
}

export function v2SnapshotUrl(filename: string): string {
  return `${V2_SNAPSHOTS_URL}/${filename}`;
}

export async function putV2Snapshot(
  filename: string,
  body: BodyInit,
  extra?: HeadersInit,
): Promise<Response> {
  return fetchConfigured(v2SnapshotUrl(filename), {
    method: "PUT",
    headers: await v2WriteHeaders({
      "Content-Type": "application/octet-stream",
      "If-None-Match": "*",
      ...headerRecord(extra),
    }),
    body,
  });
}

export async function getV2Snapshot(filename: string): Promise<Response> {
  return fetchConfigured(v2SnapshotUrl(filename), { headers: await authHeaders() });
}

export async function listV2Snapshots(): Promise<Response> {
  return fetchConfigured(V2_SNAPSHOTS_URL, { headers: await authHeaders() });
}

export async function getV2Head(): Promise<Response> {
  return fetchConfigured(V2_HEAD_URL, { headers: await authHeaders() });
}

export async function putV2Head(
  filename: string,
  extra?: HeadersInit,
): Promise<Response> {
  return fetchConfigured(V2_HEAD_URL, {
    method: "PUT",
    headers: await v2WriteHeaders({
      "Content-Type": "application/json",
      ...headerRecord(extra),
    }),
    body: JSON.stringify({ schema: "vibe-prompt.head/2", snapshot: filename }),
  });
}

export async function deleteV2Snapshot(
  filename: string,
  etag?: string,
): Promise<Response> {
  const extra = etag === undefined ? undefined : { "If-Match": etag };
  return fetchConfigured(v2SnapshotUrl(filename), {
    method: "DELETE",
    headers: await v2WriteHeaders(extra),
  });
}

export type V2SnapshotListBody = {
  schema: string;
  items: Array<{
    name: string;
    size: number;
    createdAt: string;
    etag: string;
    isHead: boolean;
  }>;
};

export type ErrorBody = {
  error: { code: string; message: string };
};
