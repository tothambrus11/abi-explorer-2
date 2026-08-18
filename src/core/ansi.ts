// Minimal ANSI SGR (Select Graphic Rendition) reader — enough for clang's
// colored diagnostics: bold, reset, and the 16 foreground colors.

export interface AnsiSpan {
  text: string;
  bold: boolean;
  /** 0-7 standard, 8-15 bright; null = default. */
  color: number | null;
}

// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1b\[([0-9;]*)m/g;

export function parseAnsi(text: string): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  let bold = false;
  let color: number | null = null;
  let last = 0;
  const push = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev?.bold === bold && prev.color === color) prev.text += t;
    else out.push({ text: t, bold, color });
  };
  for (const m of text.matchAll(SGR_RE)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const codes = (m[1] ?? '').split(';').filter(Boolean).map(Number);
    if (codes.length === 0) codes.push(0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) {
        bold = false;
        color = null;
      } else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) color = null;
      else if (c >= 30 && c <= 37) color = c - 30;
      else if (c >= 90 && c <= 97) color = c - 90 + 8;
      else if (c === 38 && codes[i + 1] === 5) {
        color = null;
        i += 2;
      } // 256-color: ignore
    }
  }
  push(text.slice(last));
  return out;
}

/** Remove all SGR sequences. */
export function stripAnsi(text: string): string {
  return text.replace(SGR_RE, '');
}
