// Sizes in words. Whole bytes print as bytes; anything else (a bit-field) as bits.

export function formatSize(bits: number): string {
  if (bits % 8 !== 0) return bits === 1 ? '1 bit' : `${bits} bits`;
  const bytes = bits / 8;
  return bytes === 1 ? '1 byte' : `${bytes} bytes`;
}

/** The short form, as the web explorer writes it: `4 B`, `3 b`. */
export function formatSizeShort(bits: number): string {
  return bits % 8 !== 0 ? `${bits} b` : `${bits / 8} B`;
}

/** An offset as the web explorer writes it: `8 B`, or `8 B + 3 b` for bit 3 of byte 8. */
export function formatOffset(bits: number): string {
  return bits % 8 === 0 ? `${bits / 8} B` : `${Math.floor(bits / 8)} B + ${bits % 8} b`;
}
