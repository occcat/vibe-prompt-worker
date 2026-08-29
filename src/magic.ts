const VPBE_MAGIC = [86, 80, 66, 69] as const;

export function hasVpbeMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < VPBE_MAGIC.length) {
    return false;
  }
  for (let i = 0; i < VPBE_MAGIC.length; i++) {
    if (bytes[i] !== VPBE_MAGIC[i]) {
      return false;
    }
  }
  return true;
}
