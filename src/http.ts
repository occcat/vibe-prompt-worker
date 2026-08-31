export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "misconfigured"
  | "not_found"
  | "invalid_protocol"
  | "invalid_path"
  | "invalid_json"
  | "invalid_magic"
  | "invalid_content_type"
  | "invalid_storage"
  | "precondition_required"
  | "precondition_failed"
  | "payload_too_large"
  | "method_not_allowed"
  | "snapshot_is_head"
  | "snapshot_not_found"
  | "storage_unavailable";

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
