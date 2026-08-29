import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  fetchConfigured,
  getIndex,
  getVault,
  HEALTH_URL,
  INDEX_URL,
  KDF_SALT,
  putVault,
  VAULT_ID,
  vaultDocument,
  writeHeaders,
  type ErrorBody,
  type IndexBody,
} from "./helpers";

describe("PUT /v1/vault preconditions", () => {
  it("creates with If-None-Match:* and rejects a second create with 412", async () => {
    const created = await putVault(vaultDocument());
    expect(created.status).toBe(201);
    expect(created.headers.get("ETag")).toBe('"1"');
    expect(created.headers.get("X-Vibe-Prompt-Revision")).toBe("1");

    const duplicate = await putVault(vaultDocument());
    expect(duplicate.status).toBe(412);
    const duplicateBody = await duplicate.json() as ErrorBody;
    expect(duplicateBody.error.code).toBe("precondition_failed");
  });

  it("GET then If-Match updates encryption but cannot change vaultId or kdfSalt", async () => {
    const created = await putVault(vaultDocument());
    expect(created.status).toBe(201);
    const etag = created.headers.get("ETag");
    expect(etag).toBe('"1"');

    const got = await getVault();
    expect(got.status).toBe(200);
    expect(got.headers.get("ETag")).toBe(etag);
    const vault = await got.json() as Record<string, unknown>;
    expect(vault.vaultId).toBe(VAULT_ID);
    expect(vault.kdfSalt).toBe(KDF_SALT);
    expect(vault.encryption).toBe("required");

    const updated = await putVault(vaultDocument({ encryption: "optional" }), {
      "If-Match": etag!,
    });
    expect(updated.status).toBe(204);
    expect(updated.headers.get("ETag")).toBe('"2"');

    const afterUpdate = await getVault();
    expect(afterUpdate.status).toBe(200);
    const updatedVault = await afterUpdate.json() as Record<string, unknown>;
    expect(updatedVault.encryption).toBe("optional");
    expect(updatedVault.vaultId).toBe(VAULT_ID);
    expect(updatedVault.kdfSalt).toBe(KDF_SALT);

    const changeId = await putVault(
      vaultDocument({
        encryption: "optional",
        vaultId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      }),
      { "If-Match": '"2"' },
    );
    expect(changeId.status).toBe(409);
    const changeIdBody = await changeId.json() as ErrorBody;
    expect(changeIdBody.error.code).toBe("conflict");

    const changeSalt = await putVault(
      vaultDocument({
        encryption: "optional",
        kdfSalt: "ffffffffffffffffffffffffffffffff",
      }),
      { "If-Match": '"2"' },
    );
    expect(changeSalt.status).toBe(409);
    const changeSaltBody = await changeSalt.json() as ErrorBody;
    expect(changeSaltBody.error.code).toBe("conflict");
  });

  it("PUT vault without If-Match or If-None-Match is 428", async () => {
    const response = await fetchConfigured("https://worker.test/v1/vault", {
      method: "PUT",
      headers: await writeHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(vaultDocument()),
    });
    expect(response.status).toBe(428);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("precondition_required");
  });

  it("PUT vault with invalid JSON is 400 invalid_json", async () => {
    const response = await putVault({ schema: "nope" });
    expect(response.status).toBe(400);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("invalid_json");
  });

  it("GET /v1/vault is 404 when the vault has not been created", async () => {
    const response = await getVault();
    expect(response.status).toBe(404);
    const body = await response.json() as ErrorBody;
    expect(body.error.code).toBe("not_found");
  });
});

describe("GET /v1/index and method restrictions", () => {
  it("GET /v1/index returns the global revision and no PUT /v1/index", async () => {
    expect((await putVault(vaultDocument())).status).toBe(201);

    const index = await getIndex();
    expect(index.status).toBe(200);
    const body = await index.json() as IndexBody;
    expect(body.schema).toBe("vibe-prompt.index/1");
    expect(body.revision).toBe(1);
    expect(body.items).toEqual([]);
    expect(body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const putIndex = await fetchConfigured(INDEX_URL, {
      method: "PUT",
      headers: await writeHeaders({ "content-type": "application/json" }),
      body: "{}",
    });
    expect(putIndex.status).toBe(405);
    const putBody = await putIndex.json() as ErrorBody;
    expect(putBody.error.code).toBe("method_not_allowed");
  });
});

describe("health capabilities after object CRUD", () => {
  it("does not advertise batch-push", async () => {
    const response = await fetchConfigured(HEALTH_URL);
    expect(response.status).toBe(200);
    const body = await response.json() as { capabilities: string[] };
    expect(body.capabilities).not.toContain("batch");
    expect(body.capabilities).not.toContain("batch-push");
  });

  it("GET /v1/health without AUTH_VALUE is still 200", async () => {
    expect(env.AUTH_VALUE ?? "").toBe("");
    const response = await exports.default.fetch(HEALTH_URL);
    expect(response.status).toBe(200);
    const body = await response.json() as { authConfigured: boolean };
    expect(body.authConfigured).toBe(false);
  });
});
