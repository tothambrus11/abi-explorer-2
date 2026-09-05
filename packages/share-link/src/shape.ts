// Reading a stranger's JSON: what a value is, if it is what a key should hold.

/** `value` as a plain object, or an empty one for anything else. */
export function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `value` if it is a string, else `fallback`. */
export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
