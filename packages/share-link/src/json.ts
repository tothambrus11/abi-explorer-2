// A JSON value as bytes and back: what every envelope wraps.

export function toJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Throws on bytes that are not JSON; callers treat that as a link they cannot read. */
export function fromJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}
