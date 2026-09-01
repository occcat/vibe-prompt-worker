import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

const HEALTH_URL = "https://worker.test/v2/health";

describe("snapshot-only bootstrap routes", () => {
  it("serves the root marker and unauthenticated v2 health", async () => {
    const root = await exports.default.fetch("https://worker.test/");
    expect(root.status).toBe(200);
    expect(await root.text()).toBe("vibe-prompt-worker");
    expect(root.headers.get("Cache-Control")).toBeNull();

    const health = await exports.default.fetch(HEALTH_URL);
    expect(health.status).toBe(200);
    expect(health.headers.get("Cache-Control")).toBe("no-store, no-transform");
    expect(await health.json()).toEqual({
      schema: "vibe-prompt.health/2",
      name: "vibe-prompt-worker",
      protocolVersion: 2,
      backend: "r2-snapshot",
      capabilities: ["snapshot-head", "snapshot-history", "etag", "if-match"],
      authConfigured: false,
    });
  });

  it("reports configured authentication without exposing the secret", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(HEALTH_URL),
      { ...env, AUTH_VALUE: "test-secret" },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authConfigured: true });
  });

  it("returns 404 for every retired v1 route and method before auth checks", async () => {
    for (const [path, method] of [
      ["/v1/health", "GET"],
      ["/v1/vault", "PUT"],
      ["/v1/index", "GET"],
      ["/v1/sync/push", "POST"],
      ["/v1/objects/prompts/id", "DELETE"],
      ["/v1/snapshots", "GET"],
    ]) {
      const response = await exports.default.fetch(`https://worker.test${path}`, { method });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "not_found", message: "Not Found" },
      });
    }
  });

  it("keeps preflight unauthenticated and exposes only v2 headers", async () => {
    const response = await exports.default.fetch("https://worker.test/v2/head", {
      method: "OPTIONS",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods"))
      .toBe("GET, PUT, DELETE, OPTIONS, HEAD");
    expect(response.headers.get("Access-Control-Expose-Headers"))
      .toBe("ETag, X-Vibe-Prompt-Manifest-ETag");
    expect(response.headers.get("Access-Control-Allow-Headers"))
      .not.toContain("X-Vibe-Prompt-Device-Id");
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
  });
});
