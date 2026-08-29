import { isCanonicalUtc } from "./canonical";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const KDF_SALT_RE = /^[0-9a-f]{32}$/;
export const SCOPE_ID_RE = /^[a-z0-9._-]+$/;

export type VaultEncryption = "required" | "optional" | "forbidden";

export type VaultDocument = {
  schema: "vibe-prompt.vault/1";
  protocolVersion: 1;
  vaultId: string;
  encryption: VaultEncryption;
  kdf: "vault-v1";
  kdfSalt: string;
  snapshotRetention: {
    maxCount: 30;
    maxBytes: 629145600;
  };
};

export type TombstoneDocument = {
  schema: "vibe-prompt.tombstone/1";
  targetKind: "prompt" | "label" | "scope";
  id: string;
  deletedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseVaultJson(value: unknown): VaultDocument | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.schema !== "vibe-prompt.vault/1") {
    return null;
  }
  if (value.protocolVersion !== 1) {
    return null;
  }
  if (typeof value.vaultId !== "string" || !UUID_RE.test(value.vaultId)) {
    return null;
  }
  if (
    value.encryption !== "required" &&
    value.encryption !== "optional" &&
    value.encryption !== "forbidden"
  ) {
    return null;
  }
  if (value.kdf !== "vault-v1") {
    return null;
  }
  if (typeof value.kdfSalt !== "string" || !KDF_SALT_RE.test(value.kdfSalt)) {
    return null;
  }
  if (!isRecord(value.snapshotRetention)) {
    return null;
  }
  if (value.snapshotRetention.maxCount !== 30) {
    return null;
  }
  if (value.snapshotRetention.maxBytes !== 629145600) {
    return null;
  }
  return {
    schema: "vibe-prompt.vault/1",
    protocolVersion: 1,
    vaultId: value.vaultId,
    encryption: value.encryption,
    kdf: "vault-v1",
    kdfSalt: value.kdfSalt,
    snapshotRetention: {
      maxCount: 30,
      maxBytes: 629145600,
    },
  };
}

export function parseTombstoneJson(
  value: unknown,
  expected: { targetKind: string; id: string },
): TombstoneDocument | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.schema !== "vibe-prompt.tombstone/1") {
    return null;
  }
  if (
    value.targetKind !== "prompt" &&
    value.targetKind !== "label" &&
    value.targetKind !== "scope"
  ) {
    return null;
  }
  if (value.targetKind !== expected.targetKind) {
    return null;
  }
  if (typeof value.id !== "string" || value.id !== expected.id) {
    return null;
  }
  if (typeof value.deletedAt !== "string" || !isCanonicalUtc(value.deletedAt)) {
    return null;
  }
  return {
    schema: "vibe-prompt.tombstone/1",
    targetKind: value.targetKind,
    id: value.id,
    deletedAt: value.deletedAt,
  };
}
