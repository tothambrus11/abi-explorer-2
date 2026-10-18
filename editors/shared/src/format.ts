// Sizes in words. Whole bytes print as bytes; anything else (a bit-field) as bits.

export function formatSize(bits: number): string {
  if (bits % 8 !== 0) return bits === 1 ? '1 bit' : `${bits} bits`;
  const bytes = bits / 8;
  return bytes === 1 ? '1 byte' : `${bytes} bytes`;
}

/** The short form, where space is tight: `4 B`, `3 bits`. */
export function formatSizeShort(bits: number): string {
  if (bits % 8 !== 0) return bits === 1 ? '1 bit' : `${bits} bits`;
  return `${bits / 8} B`;
}

/** An offset: `8`, or `8.3` for bit 3 of byte 8. */
export function formatOffset(bits: number): string {
  return bits % 8 === 0 ? `${bits / 8}` : `${Math.floor(bits / 8)}.${bits % 8}`;
}
