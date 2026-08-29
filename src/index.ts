import { verifyAuthorization } from "./auth";
import { errorResponse, jsonResponse } from "./http";
import { isObjectPutTooLarge, isSnapshotPutTooLarge } from "./limits";
import { isSnapshotRoute } from "./paths";

export { VaultObject } from "./vault-object";

const WORKER_NAME = "vibe-prompt-worker";
const HEALTH_SCHEMA = "vibe-prompt.health/1";
const HEALTH_CAPABILITIES = ["etag", "if-match", "index-atomic"] as const;
const PROTOCOL_HEADER = "X-Vibe-Prompt-Protocol";
const PROTOCOL_VERSION = "1";
const WRITE_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, POST, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": [
    "Authorization",
    "Content-Type",
    "If-Match",
    "If-None-Match",
    "X-Vibe-Prompt-Protocol",
    "X-Vibe-Prompt-Device-Id",
  ].join(", "),
  "Access-Control-Expose-Headers": "ETag, X-Vibe-Prompt-Revision",
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return withCors(await handleRequest(request, env));
  },
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (request.method === "GET" && pathname === "/") {
    return new Response(WORKER_NAME, {
      headers: { "content-type": "text/plain" },
    });
  }

  if (request.method === "GET" && pathname === "/v1/health") {
    return jsonResponse({
      schema: HEALTH_SCHEMA,
      name: WORKER_NAME,
      protocolVersion: 1,
      backend: "worker",
      capabilities: [...HEALTH_CAPABILITIES],
      authConfigured: isAuthConfigured(env.AUTH_VALUE),
    });
  }

  if (isSharePath(pathname)) {
    return errorResponse(404, "not_found", "Not Found");
  }

  if (!isAuthConfigured(env.AUTH_VALUE)) {
    return errorResponse(503, "misconfigured", "Must set AUTH_VALUE environment.");
  }

  const authorization = await verifyAuthorization(
    request.headers.get("Authorization"),
    env.AUTH_VALUE,
  );
  if (authorization === "missing") {
    return errorResponse(401, "unauthorized", "Missing Authorization bearer token.");
  }
  if (authorization === "invalid") {
    return errorResponse(403, "forbidden", "Sorry, you have supplied an invalid key.");
  }

  if (hasInvalidProtocol(request)) {
    return errorResponse(400, "invalid_protocol", "X-Vibe-Prompt-Protocol must be 1.");
  }

  if (isObjectPutTooLarge(request)) {
    return errorResponse(413, "payload_too_large", "Payload too large.");
  }

  if (isSnapshotPutTooLarge(request)) {
    return errorResponse(413, "payload_too_large", "Payload too large.");
  }

  if (isSnapshotRoute(pathname) && !hasSnapshotsBinding(env)) {
    return errorResponse(503, "misconfigured", "Must bind SNAPSHOTS R2 bucket.");
  }

  return env.VAULT.get(env.VAULT.idFromName("vault")).fetch(request);
}

function isAuthConfigured(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasSnapshotsBinding(env: Env): boolean {
  try {
    return env.SNAPSHOTS !== undefined && env.SNAPSHOTS !== null;
  } catch {
    return false;
  }
}

function isSharePath(pathname: string): boolean {
  return pathname === "/v1/share" || pathname.startsWith("/v1/share/");
}

function hasInvalidProtocol(request: Request): boolean {
  const raw = request.headers.get(PROTOCOL_HEADER);
  if (raw === null) {
    return WRITE_METHODS.has(request.method);
  }
  return raw.trim() !== PROTOCOL_VERSION;
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
