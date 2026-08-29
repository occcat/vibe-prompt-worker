import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

const AUTH_VALUE = "test-secret";
const TOKEN_SALT = "vibe-prompt-worker-v1";
const VAULT_URL = "https://worker.test/v1/vault";
const HEALTH_URL = "https://worker.test/v1/health";
const SHARE_URL = "https://worker.test/v1/share/x";
const PROTOCOL_HEADER = "X-Vibe-Prompt-Protocol";
const FORBIDDEN_MESSAGE = "Sorry, you have supplied an invalid key.";
const UNAUTHORIZED_MESSAGE = "Missing Authorization bearer token.";
const INVALID_PROTOCOL_MESSAGE = "X-Vibe-Prompt-Protocol must be 1.";

const CORS_ALLOW_METHODS = "GET, PUT, DELETE, POST, OPTIONS, HEAD";
const CORS_ALLOW_HEADERS = [
  "Authorization",
  "Content-Type",
  "If-Match",
  "If-None-Match",
  "X-Vibe-Prompt-Protocol",
  "X-Vibe-Prompt-Device-Id",
].join(", ");
const CORS_EXPOSE_HEADERS = "ETag, X-Vibe-Prompt-Revision";

async function hexSha256Utf8(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function bearerToken(authValue: string): Promise<string> {
  return hexSha256Utf8(`${authValue}${TOKEN_SALT}`);
}

function configuredEnv(authValue = AUTH_VALUE): Env {
  return { ...env, AUTH_VALUE: authValue };
}

async function fetchConfigured(input: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(input, init), configuredEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function authHeaders(extra?: HeadersInit): Promise<Headers> {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${await bearerToken(AUTH_VALUE)}`);
  return headers;
}

function expectCors(response: Response): void {
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("Access-Control-Allow-Methods")).toBe(CORS_ALLOW_METHODS);
  expect(response.headers.get("Access-Control-Allow-Headers")).toBe(CORS_ALLOW_HEADERS);
  expect(response.headers.get("Access-Control-Expose-Headers")).toBe(CORS_EXPOSE_HEADERS);
}

async function expectError(
  response: Response,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
  expect(await response.json()).toEqual({ error: { code, message } });
  expectCors(response);
}

describe("auth exceptions when AUTH_VALUE is set", () => {
  it("GET /v1/health is 200 without Authorization", async () => {
    const response = await fetchConfigured(HEALTH_URL);
    expect(response.status).toBe(200);
    const body = await response.json() as { authConfigured: boolean };
    expect(body.authConfigured).toBe(true);
    expectCors(response);
  });

  it("GET /v1/share/x is 404 without Authorization, not 401", async () => {
    await expectError(
      await fetchConfigured(SHARE_URL),
      404,
      "not_found",
      "Not Found",
    );
  });

  it("GET / is 200 without Authorization", async () => {
    const response = await fetchConfigured("https://worker.test/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("vibe-prompt-worker");
    expectCors(response);
  });
});

describe("bearer on authenticated routes", () => {
  it("GET /v1/vault without Authorization is 401 unauthorized", async () => {
    await expectError(
      await fetchConfigured(VAULT_URL),
      401,
      "unauthorized",
      UNAUTHORIZED_MESSAGE,
    );
  });

  it("GET /v1/vault with the wrong Bearer is 403 with the kiss-worker message", async () => {
    await expectError(
      await fetchConfigured(VAULT_URL, {
        headers: { Authorization: "Bearer deadbeef" },
      }),
      403,
      "forbidden",
      FORBIDDEN_MESSAGE,
    );
  });

  it("GET /v1/vault with the raw AUTH_VALUE as Bearer is 403", async () => {
    await expectError(
      await fetchConfigured(VAULT_URL, {
        headers: { Authorization: `Bearer ${AUTH_VALUE}` },
      }),
      403,
      "forbidden",
      FORBIDDEN_MESSAGE,
    );
  });

  it("GET /v1/vault with the correct Bearer is not 401 or 403", async () => {
    const response = await fetchConfigured(VAULT_URL, {
      headers: await authHeaders(),
    });
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
    expectCors(response);
  });
});

describe("X-Vibe-Prompt-Protocol", () => {
  it("PUT /v1/vault with correct Bearer and no protocol is 400 invalid_protocol", async () => {
    await expectError(
      await fetchConfigured(VAULT_URL, {
        method: "PUT",
        headers: await authHeaders(),
      }),
      400,
      "invalid_protocol",
      INVALID_PROTOCOL_MESSAGE,
    );
  });

  it("PUT /v1/vault with protocol 2 is 400 invalid_protocol", async () => {
    await expectError(
      await fetchConfigured(VAULT_URL, {
        method: "PUT",
        headers: await authHeaders({ [PROTOCOL_HEADER]: "2" }),
      }),
      400,
      "invalid_protocol",
      INVALID_PROTOCOL_MESSAGE,
    );
  });

  it("PUT /v1/vault with protocol 1 and correct Bearer is not invalid_protocol", async () => {
    const response = await fetchConfigured(VAULT_URL, {
      method: "PUT",
      headers: await authHeaders({ [PROTOCOL_HEADER]: "1" }),
    });
    expect(response.status).not.toBe(400);
    if (response.headers.get("content-type")?.includes("application/json")) {
      const body = await response.json() as { error?: { code?: string } };
      expect(body.error?.code).not.toBe("invalid_protocol");
    }
    expectCors(response);
  });

  it("GET /v1/vault with protocol 2 is 400 invalid_protocol", async () => {
    await expectError(
      await fetchConfigured(VAULT_URL, {
        headers: await authHeaders({ [PROTOCOL_HEADER]: "2" }),
      }),
      400,
      "invalid_protocol",
      INVALID_PROTOCOL_MESSAGE,
    );
  });

  it("GET /v1/vault with protocol 1 and correct Bearer is not invalid_protocol", async () => {
    const response = await fetchConfigured(VAULT_URL, {
      headers: await authHeaders({ [PROTOCOL_HEADER]: "1" }),
    });
    expect(response.status).not.toBe(400);
    expectCors(response);
  });

  it("PUT /v1/vault without Authorization is 401 even with protocol 1", async () => {
    await expectError(
      await fetchConfigured(VAULT_URL, {
        method: "PUT",
        headers: { [PROTOCOL_HEADER]: "1" },
      }),
      401,
      "unauthorized",
      UNAUTHORIZED_MESSAGE,
    );
  });

  it("PUT /v1/vault with the wrong Bearer is 403 even with protocol 1", async () => {
    await expectError(
      await fetchConfigured(VAULT_URL, {
        method: "PUT",
        headers: {
          Authorization: "Bearer deadbeef",
          [PROTOCOL_HEADER]: "1",
        },
      }),
      403,
      "forbidden",
      FORBIDDEN_MESSAGE,
    );
  });

  it("POST /v1/sync/push with correct Bearer and no protocol is 400", async () => {
    await expectError(
      await fetchConfigured("https://worker.test/v1/sync/push", {
        method: "POST",
        headers: await authHeaders(),
      }),
      400,
      "invalid_protocol",
      INVALID_PROTOCOL_MESSAGE,
    );
  });
});

describe("CORS", () => {
  it("OPTIONS /v1/vault is 204 with CORS allow headers and methods", async () => {
    const response = await exports.default.fetch(VAULT_URL, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expectCors(response);
  });

  it("OPTIONS /v1/vault is 204 without Authorization when AUTH_VALUE is set", async () => {
    const response = await fetchConfigured(VAULT_URL, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expectCors(response);
  });

  it("OPTIONS /v1/share/x is 204 with CORS headers", async () => {
    const response = await exports.default.fetch(SHARE_URL, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expectCors(response);
  });

  it("503 misconfigured responses include CORS headers", async () => {
    const response = await exports.default.fetch(VAULT_URL);
    expect(response.status).toBe(503);
    expectCors(response);
  });
});
