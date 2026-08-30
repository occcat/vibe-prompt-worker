export const META_VAULT_JSON = "vault_json";
export const META_VAULT_REVISION = "vault_revision";
export const META_OBJECT_REVISION = "object_revision";
export const META_INDEX_UPDATED_AT = "index_updated_at";

export function one<T extends Record<string, SqlStorageValue>>(
  sql: SqlStorage,
  query: string,
  ...bindings: SqlStorageValue[]
): T | null {
  return sql.exec<T>(query, ...bindings).toArray()[0] ?? null;
}

export function all<T extends Record<string, SqlStorageValue>>(
  sql: SqlStorage,
  query: string,
  ...bindings: SqlStorageValue[]
): T[] {
  return sql.exec<T>(query, ...bindings).toArray();
}

export function getMeta(sql: SqlStorage, key: string): string | null {
  const row = one<{ v: string }>(sql, "SELECT v FROM meta WHERE k = ?", key);
  return row?.v ?? null;
}

export function setMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec(
    "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    key,
    value,
  );
}

export function objectRevision(sql: SqlStorage): number {
  const raw = getMeta(sql, META_OBJECT_REVISION);
  if (raw === null) {
    return 0;
  }
  return Number(raw);
}
