export const MAX_OBJECT_BYTES = 1_500_000;
export const MAX_INDEX_ITEMS = 8000;
export const MAX_INDEX_BYTES = 4 * 1024 * 1024;

const LIVE_OBJECT_PUT = /^\/v1\/objects\/(prompts|labels|scopes)\//;

export function indexWouldExceedLimit(
  itemCount: number,
  serializedBytes: number,
): boolean {
  return itemCount > MAX_INDEX_ITEMS || serializedBytes > MAX_INDEX_BYTES;
}

export function isObjectPutTooLarge(request: Request): boolean {
  if (request.method !== "PUT") {
    return false;
  }
  const pathname = new URL(request.url).pathname;
  if (!LIVE_OBJECT_PUT.test(pathname)) {
    return false;
  }
  const raw = request.headers.get("Content-Length");
  if (raw === null || raw === "") {
    return false;
  }
  const length = Number(raw);
  return Number.isFinite(length) && length > MAX_OBJECT_BYTES;
}
