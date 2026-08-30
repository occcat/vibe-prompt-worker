export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SCOPE_ID_RE = /^[a-z0-9._-]+$/;

export const LIVE_KIND_SPECS = [
  { singular: "prompt", url: "prompts", idPattern: UUID_RE },
  { singular: "label", url: "labels", idPattern: UUID_RE },
  { singular: "scope", url: "scopes", idPattern: SCOPE_ID_RE },
] as const;

export type SingularKind = (typeof LIVE_KIND_SPECS)[number]["singular"];
export type LiveUrlKind = (typeof LIVE_KIND_SPECS)[number]["url"];

export type LiveKindSpec = {
  singular: SingularKind;
  url: LiveUrlKind;
  idPattern: RegExp;
};

export const LIVE_URL_KINDS: readonly LiveUrlKind[] = LIVE_KIND_SPECS.map(
  (spec) => spec.url,
);

export const SINGULAR_KINDS: readonly SingularKind[] = LIVE_KIND_SPECS.map(
  (spec) => spec.singular,
);

export const LIVE_KINDS = Object.fromEntries(
  LIVE_KIND_SPECS.map((spec) => [spec.url, spec.singular]),
) as Record<LiveUrlKind, SingularKind>;

export const SINGULAR_TO_URL = Object.fromEntries(
  LIVE_KIND_SPECS.map((spec) => [spec.singular, spec.url]),
) as Record<SingularKind, LiveUrlKind>;

export const liveObjectPutPathRe = new RegExp(
  `^/v1/objects/(${LIVE_URL_KINDS.join("|")})/`,
);

export function isLiveUrlKind(value: unknown): value is LiveUrlKind {
  return LIVE_URL_KINDS.some((kind) => kind === value);
}

export function isSingularKind(value: unknown): value is SingularKind {
  return SINGULAR_KINDS.some((kind) => kind === value);
}

export function isLiveId(urlKind: LiveUrlKind, id: string): boolean {
  const spec = LIVE_KIND_SPECS.find((item) => item.url === urlKind);
  return spec !== undefined && spec.idPattern.test(id);
}
