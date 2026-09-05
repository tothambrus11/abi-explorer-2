// base64url: base64 with the URL-safe alphabet and no padding, so a link
// stays a link.

/** Chunked, because spreading a megabyte into `fromCharCode` overflows the stack. */
export function toBase64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Throws on text that is not base64url; callers treat that as a link they cannot read. */
export function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
