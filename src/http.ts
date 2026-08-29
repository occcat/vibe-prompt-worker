export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "misconfigured"
  | "not_found"
  | "invalid_protocol"
  | "invalid_path"
  | "invalid_json"
  | "invalid_magic"
  | "precondition_required"
  | "precondition_failed"
  | "payload_too_large"
  | "index_too_large"
  | "method_not_allowed"
  | "conflict"
  | "rate_limited";

export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return jsonResponse({ error: { code, message }, ...extra }, status);
}

export function quoteEtag(revision: number): string {
  return `"${revision}"`;
}

export function revisionHeaders(revision: number): Headers {
  const headers = new Headers();
  headers.set("ETag", quoteEtag(revision));
  headers.set("X-Vibe-Prompt-Revision", String(revision));
  return headers;
}

export function emptyRevisionResponse(status: number, revision: number): Response {
  return new Response(null, { status, headers: revisionHeaders(revision) });
}
