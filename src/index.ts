import { verifyAuthorization } from "./auth";
import { errorResponse, jsonResponse } from "./http";
import { routeSnapshotApi } from "./snapshot-api";

const WORKER_NAME = "vibe-prompt-worker";
const HEALTH_SCHEMA = "vibe-prompt.health/2";
const HEALTH_CAPABILITIES = [
  "snapshot-head",
  "snapshot-history",
  "etag",
  "if-match",
] as const;
const PROTOCOL_HEADER = "X-Vibe-Prompt-Protocol";
const PROTOCOL_VERSION = "2";
const V2_CACHE_CONTROL = "no-store, no-transform";
const WRITE_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": [
    "Authorization",
    "Content-Type",
    "If-Match",
    "If-None-Match",
    "X-Vibe-Prompt-Protocol",
  ].join(", "),
  "Access-Control-Expose-Headers": "ETag, X-Vibe-Prompt-Manifest-ETag",
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return withResponseHeaders(request, await handleRequest(request, env));
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
  if (request.method === "GET" && pathname === "/v2/health") {
    return jsonResponse({
      schema: HEALTH_SCHEMA,
      name: WORKER_NAME,
      protocolVersion: 2,
      backend: "r2-snapshot",
      capabilities: [...HEALTH_CAPABILITIES],
      authConfigured: isAuthConfigured(env.AUTH_VALUE),
    });
  }
  if (pathname === "/v1" || pathname.startsWith("/v1/")) {
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
    return errorResponse(
      400,
      "invalid_protocol",
      `X-Vibe-Prompt-Protocol must be ${PROTOCOL_VERSION}.`,
    );
  }

  if (pathname === "/v2/head" || pathname.startsWith("/v2/snapshots")) {
    const bucket = snapshotsBucket(env);
    if (bucket === null) {
      return errorResponse(503, "misconfigured", "Must bind SNAPSHOTS R2 bucket.");
    }
    const response = await routeSnapshotApi(request, bucket);
    if (response !== null) {
      return response;
    }
  }
  return errorResponse(404, "not_found", "Not Found");
}

function isAuthConfigured(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function snapshotsBucket(env: Env): R2Bucket | null {
  try {
    return env.SNAPSHOTS ?? null;
  } catch {
    return null;
  }
}

function hasInvalidProtocol(request: Request): boolean {
  const raw = request.headers.get(PROTOCOL_HEADER);
  if (raw === null) {
    return WRITE_METHODS.has(request.method);
  }
  return raw.trim() !== PROTOCOL_VERSION;
}

function withResponseHeaders(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  if (isV2Path(new URL(request.url).pathname)) {
    headers.set("Cache-Control", V2_CACHE_CONTROL);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isV2Path(pathname: string): boolean {
  return pathname === "/v2" || pathname.startsWith("/v2/");
}
