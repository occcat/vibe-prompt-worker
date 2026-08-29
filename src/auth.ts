const BEARER_PREFIX = "Bearer ";
const TOKEN_SALT = "vibe-prompt-worker-v1";
const encoder = new TextEncoder();

export function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  const width = Math.max(left.byteLength, right.byteLength);
  const paddedLeft = new Uint8Array(width + 4);
  const paddedRight = new Uint8Array(width + 4);
  paddedLeft.set(left);
  paddedRight.set(right);
  // Suffix lengths so a length mismatch cannot skip timingSafeEqual.
  new DataView(paddedLeft.buffer).setUint32(width, left.byteLength);
  new DataView(paddedRight.buffer).setUint32(width, right.byteLength);
  return crypto.subtle.timingSafeEqual(paddedLeft, paddedRight);
}

async function deriveBearerToken(authValue: string): Promise<string> {
  const payload = encoder.encode(`${authValue}${TOKEN_SALT}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyAuthorization(
  authorization: string | null,
  authValue: string,
): Promise<"missing" | "invalid" | "ok"> {
  if (authorization === null || authorization === "") {
    return "missing";
  }
  const presented = authorization.startsWith(BEARER_PREFIX)
    ? authorization.slice(BEARER_PREFIX.length)
    : "";
  const expected = await deriveBearerToken(authValue);
  if (!timingSafeEqualBytes(encoder.encode(presented), encoder.encode(expected))) {
    return "invalid";
  }
  return "ok";
}
