import { DurableObject } from "cloudflare:workers";

const WORKER_NAME = "vibe-prompt-worker";
const HEALTH_SCHEMA = "vibe-prompt.health/1";
const HEALTH_CAPABILITIES = ["etag", "if-match", "index-atomic"] as const;

export class VaultObject extends DurableObject<Env> {
  fetch(): Response {
    return new Response("Not Implemented", { status: 501 });
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
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
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }
      return errorResponse(404, "not_found", "Not Found");
    }

    if (!isAuthConfigured(env.AUTH_VALUE)) {
      return errorResponse(503, "misconfigured", "Must set AUTH_VALUE environment.");
    }

    return errorResponse(404, "not_found", "Not Found");
  },
} satisfies ExportedHandler<Env>;

function isAuthConfigured(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

function isSharePath(pathname: string): boolean {
  return pathname === "/v1/share" || pathname.startsWith("/v1/share/");
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(
  status: number,
  code: "not_found" | "misconfigured",
  message: string,
): Response {
  return jsonResponse({ error: { code, message } }, status);
}
