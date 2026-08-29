import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

const HEALTH_PATH = "https://worker.test/v1/health";
const EXPECTED_CAPABILITIES = ["etag", "if-match", "index-atomic", "batch-push"];

function workerFetch(input: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(input, init);
}

describe("bootstrap edge routes", () => {
  it("GET / returns 200 text vibe-prompt-worker", async () => {
    const response = await workerFetch("https://worker.test/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain\b/);
    expect(await response.text()).toBe("vibe-prompt-worker");
  });

  it("GET /v1/health with no AUTH_VALUE is 200 and unconfigured", async () => {
    expect(env.AUTH_VALUE ?? "").toBe("");
    const response = await workerFetch(HEALTH_PATH);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      capabilities: string[];
      authConfigured: boolean;
    };
    expect(body).toEqual({
      schema: "vibe-prompt.health/1",
      name: "vibe-prompt-worker",
      protocolVersion: 1,
      backend: "worker",
      capabilities: EXPECTED_CAPABILITIES,
      authConfigured: false,
    });
    expect(body.capabilities).not.toContain("batch");
    expect(body.capabilities).toContain("batch-push");
  });

  it("GET /v1/health with AUTH_VALUE set reports authConfigured true", async () => {
    const ctx = createExecutionContext();
    const configuredEnv: Env = { ...env, AUTH_VALUE: "test-secret" };
    const response = await worker.fetch(new Request(HEALTH_PATH), configuredEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as { authConfigured: boolean };
    expect(body.authConfigured).toBe(true);
  });

  it("GET /v1/share/x with no AUTH_VALUE returns 404 not 503", async () => {
    const response = await workerFetch("https://worker.test/v1/share/x");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Not Found" },
    });
  });

  it("PUT /v1/share/x with no AUTH_VALUE returns 404 not 503", async () => {
    const response = await workerFetch("https://worker.test/v1/share/x", {
      method: "PUT",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Not Found" },
    });
  });

  it("GET /v1/vault with no AUTH_VALUE returns 503 misconfigured", async () => {
    const response = await workerFetch("https://worker.test/v1/vault");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "misconfigured",
        message: "Must set AUTH_VALUE environment.",
      },
    });
  });

  it("GET /v1/objects/prompts/{uuid} with no AUTH_VALUE returns 503", async () => {
    const response = await workerFetch(
      "https://worker.test/v1/objects/prompts/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "misconfigured",
        message: "Must set AUTH_VALUE environment.",
      },
    });
  });
});
