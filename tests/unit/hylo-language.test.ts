import { describe, it, expect } from 'vitest';
import { HYLO_TOKENS, HYLO_CONFIGURATION, HYLO_KEYWORDS } from '$ui/hylo-language';
import { THEMES } from '$core/themes';

/**
 * Every token name the Hylo tokenizer emits, from the rules themselves rather
 * than from a list beside them: a rule added without a colour is exactly what
 * this is here to catch.
 */
function emittedTokens(): string[] {
  const out = new Set<string>();
  const take = (action: unknown): void => {
    if (typeof action === 'string') {
      out.add(action);
      return;
    }
    if (Array.isArray(action)) {
      for (const a of action) take(a);
      return;
    }
    if (action && typeof action === 'object') {
      const a = action as { token?: unknown; cases?: Record<string, unknown> };
      if (typeof a.token === 'string') out.add(a.token);
      for (const c of Object.values(a.cases ?? {})) take(c);
    }
  };
  for (const state of Object.values(HYLO_TOKENS.tokenizer as Record<string, unknown[][]>)) {
    for (const rule of state) take(rule[1]);
  }
  out.delete('@brackets');
  out.delete('');
  return [...out];
}

describe('the Hylo grammar', () => {
  it('emits only tokens the themes give a colour', () => {
    // Monaco resolves a token by its longest themed prefix, so `string.escape`
    // is coloured by a `string` rule. What must not happen is a token whose
    // first segment nothing names: it falls through to the editor's default
    // foreground, which is how a rule can be written and never seen.
    const themed = new Set(THEMES.flatMap((t) => t.monaco.rules.map((r) => r.token)));
    for (const token of emittedTokens()) {
      const prefixes = token.split('.').map((_, i, all) => all.slice(0, i + 1).join('.'));
      expect(
        prefixes.some((p) => themed.has(p)),
        `${token} is coloured by nothing`,
      ).toBe(true);
    }
  });

  it('makes progress on every rule', () => {
    // A Monarch rule that can match the empty string never advances, and the
    // tokenizer hangs on the line that reaches it. The block-comment state is
    // written around this, so it is worth asserting rather than remembering.
    for (const [name, state] of Object.entries(
      HYLO_TOKENS.tokenizer as Record<string, unknown[][]>,
    )) {
      for (const rule of state) {
        const pattern = rule[0] as RegExp | string;
        const source = typeof pattern === 'string' ? pattern : pattern.source;
        expect(new RegExp(source).test(''), `${name}: /${source}/ matches nothing`).toBe(false);
      }
    }
  });

  it('keeps what the grammar predates apart from what it says', () => {
    // `struct`, `enum` and `case` are hylo-new's, added because the upstream
    // grammar describes the older surface syntax. If a grammar update brings
    // them in, this is where the duplication would show.
    const keywords = HYLO_KEYWORDS;
    expect(new Set(keywords).size).toBe(keywords.length);
    for (const word of ['fun', 'let', 'inout', 'sink', 'public', 'trait', 'type']) {
      expect(keywords).toContain(word);
    }
    for (const word of ['struct', 'enum', 'case']) {
      expect(keywords).toContain(word);
    }
  });

  it('comments Hylo with Hylo markers', () => {
    expect(HYLO_CONFIGURATION.comments?.lineComment).toBe('//');
    expect(HYLO_CONFIGURATION.comments?.blockComment).toEqual(['/*', '*/']);
  });
});
