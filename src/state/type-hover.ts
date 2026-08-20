// What is under the pointer, and how to say it.
//
// Two questions, and only the first is interesting: deciding *what* a word
// refers to is a chain of four rules over the analysis, and it was buried in an
// async method on a rune-driven class where nothing could reach it. Formatting
// the answer, and measuring a spelling the analysis has no record for, stay
// with the session. One needs the analyzer, the other is a template.

import type { AnalysedRecord, Analysis } from '$compiler/AbiAnalyzer';
import { directMembers } from '$core/render';
import type { LineInfo } from './code-locations';

/** What a word at a position turned out to be. */
export type Subject =
  /** Records whose name is written exactly there. Templates share a name. */
  | { kind: 'records'; records: AnalysedRecord[] }
  /** A type spelling to describe, with what it resolves to if that differs. */
  | { kind: 'spelling'; spelling: string; alias: string | null };

export interface HoverContext {
  analysis: Analysis;
  /** The editor's per-line index, for the member declared on this line. */
  lines: Map<number, LineInfo>;
  /** Spellings clang reported somewhere in the TU: the only bare words worth probing. */
  knownSpellings: ReadonlySet<string>;
}

export interface HoverWord {
  word: string;
  /** 1-based. */
  startColumn: number;
}

/** A word with both ends, as the editor reports it. */
export interface WordRange extends HoverWord {
  /** 1-based, just past the last character. */
  endColumn: number;
}

/**
 * Widen a word to the template arguments written after it.
 *
 * An editor's idea of a word stops at `<`, so the pointer on `Pair<char>` asks
 * about `Pair`, a spelling both instantiations answer to, and an index can
 * only return one of them. They are different records with different sizes,
 * and the pointer was on exactly one.
 *
 * Depth-counted rather than matched: `Pair<Pair<int>>` nests, and its closing
 * `>>` is one token to a lexer and two brackets here. A `;`, `{` or `}` first
 * means the `<` was a comparison and not an argument list at all. `a < b` is
 * a thing people write.
 */
export function widenToTemplateArgs(lineText: string, word: WordRange): WordRange {
  if (lineText[word.endColumn - 1] !== '<') return word;
  let depth = 0;
  for (let i = word.endColumn - 1; i < lineText.length; i++) {
    const ch = lineText[i];
    if (ch === '<') depth++;
    else if (ch === '>') {
      depth--;
      if (depth === 0) {
        return {
          word: lineText.slice(word.startColumn - 1, i + 1),
          startColumn: word.startColumn,
          endColumn: i + 2,
        };
      }
    } else if (ch === ';' || ch === '{' || ch === '}') break;
  }
  return word;
}

/**
 * Resolve a word to what it names, or null when it names nothing worth asking
 * about: a member name, a keyword, a number. Returning null matters as much
 * as the rest: the fallback is a probe, which is a full re-parse of the user's
 * translation unit, and running one because the pointer crossed `struct` would
 * make hovering the editor cost a compile per word.
 */
export function subjectAt(line: number, word: HoverWord, ctx: HoverContext): Subject | null {
  const { analysis } = ctx;
  const covers = (at: { line: number; col: number } | null, len: number) =>
    at !== null &&
    at.line === line &&
    word.startColumn >= at.col &&
    word.startColumn < at.col + Math.max(1, len);

  // 1. A record whose name is written exactly here.
  const records = analysis.records.filter(
    (r) => r.record.location?.isMainFile && covers(r.record.location, r.record.name.length),
  );
  if (records.length) return { kind: 'records', records: records.slice(0, 4) };

  // 2. A type name declared here. When it names a record, that record answers.
  const typedef = analysis.typedefs.find(
    (t) => t.location?.isMainFile && covers(t.location, t.name.length),
  );
  if (typedef) {
    if (typedef.recordId !== null) {
      const rec = analysis.byId.get(typedef.recordId);
      if (rec) return { kind: 'records', records: [rec] };
    }
    return { kind: 'spelling', spelling: typedef.name, alias: typedef.canonicalType };
  }

  // 3. The type part of a member declaration: the member's declared type.
  const info = ctx.lines.get(line);
  const first = info?.items[0];
  if (info && first?.type && word.startColumn < info.anchor.col) {
    return spellingSubject(first.type, analysis);
  }

  // 4. A bare name clang reported as a type somewhere in this translation unit.
  if (ctx.knownSpellings.has(word.word)) return spellingSubject(word.word, analysis);

  return null;
}

/** A spelling the analysis may already have a record for. */
function spellingSubject(spelling: string, analysis: Analysis): Subject {
  const named = analysis.byName.get(spelling);
  return named
    ? { kind: 'records', records: [named] }
    : { kind: 'spelling', spelling, alias: null };
}

/** Markdown for a record: what it is, and the numbers worth the hover. */
export function describeRecord(entry: AnalysedRecord): string {
  const r = entry.record;
  // Members of the record itself. A compound member counts once, not once per
  // field inside it.
  const n = directMembers(entry.model).filter((u) => !('kind' in u && u.kind === 'special')).length;
  const padding = entry.model.paddingBytes;
  const rows = [`| sizeof | **${r.sizeBytes}** B |`, `| alignof | **${r.align}** B |`];
  if (padding !== null) {
    const pct = r.sizeBytes ? ` (${Math.round((100 * padding) / r.sizeBytes)}%)` : '';
    rows.push(`| padding | ${padding} B${pct} |`);
  }
  if (r.dsize !== undefined) rows.push(`| dsize | ${r.dsize} B |`);
  if (r.nvsize !== undefined) rows.push(`| nvsize | ${r.nvsize} B |`);
  if (r.nvalign !== undefined) rows.push(`| nvalign | ${r.nvalign} B |`);
  return `**\`${entry.key}\`** · ${n} member${n === 1 ? '' : 's'}\n\n| | |\n|---|---|\n${rows.join('\n')}`;
}

/** Markdown for a measured spelling that is not a record of its own. */
export function describeSpelling(
  spelling: string,
  alias: string | null,
  measured: { bits: number; align: number },
): string {
  const size = measured.bits % 8 ? `${measured.bits} b` : `**${measured.bits / 8}** B`;
  const canon = alias && alias !== spelling ? `\n\n\`= ${alias}\`` : '';
  return `**\`${spelling}\`**${canon}\n\n| | |\n|---|---|\n| sizeof | ${size} |\n| alignof | **${measured.align}** B |`;
}
