// Reads member source locations (and declared types) out of clang's
// `-ast-dump=json` output as produced with `-ast-dump-filter=<record name>`.
//
// The JSON dumper omits "file"/"line" from a location when unchanged from the
// previously *written* location, so we replay the document in key order and
// keep running state. Locations appear under "loc", "range.begin/end",
// "spellingLoc" and "expansionLoc".

import type { Leaf, Group } from './types';

export interface FieldLocation {
  /** Unqualified name of the innermost enclosing record ('' for anonymous). */
  owner: string;
  /** Fully-qualified enclosing scope (e.g. `A::S`, `n::T`), matching the layout dump. */
  qualifiedOwner: string;
  /** Field name ('' for anonymous struct/union members). */
  name: string;
  line: number;
  /** 1-based column of the field name. */
  col: number;
  /** Declared type as clang prints it (e.g. "uint64_t", "struct Header"). */
  qualType: string;
  /** Canonical type, when different (e.g. "unsigned long"). */
  desugaredType?: string;
  /** Explicit `_Alignas`/`alignas`/`aligned` on the member, evaluated by clang (bytes). */
  alignAttr?: number;
}

/** A named declaration whose name is written at (line, col): records and typedefs. */
export interface DeclLocation {
  kind: 'record' | 'typedef';
  name: string;
  line: number;
  col: number;
  /** For typedefs: the aliased type as clang prints it. */
  qualType?: string;
  /**
   * First and last line of the whole declaration (clang's `range`), so a cursor
   * can be resolved to the innermost record it sits in. Inclusive on both ends.
   */
  span?: { begin: number; end: number };
}

export interface AstInfo {
  fields: FieldLocation[];
  decls: DeclLocation[];
}

const LOC_KEYS = new Set(['loc', 'begin', 'end', 'spellingLoc', 'expansionLoc']);
const RECORD_KINDS = new Set([
  'RecordDecl',
  'CXXRecordDecl',
  'ClassTemplateSpecializationDecl',
  'ClassTemplatePartialSpecializationDecl',
]);
const NAMESPACE_KINDS = new Set(['NamespaceDecl']);

interface Scope {
  /** Unqualified name of the innermost enclosing record. */
  owner: string;
  /** Qualified scope path (records + namespaces), as the layout dump prints it. */
  qualified: string;
}

interface LocState {
  file: string;
  line: number;
  col: number;
}

type JsonNode = Record<string, unknown>;
const str = (o: JsonNode, k: string): string | undefined =>
  typeof o[k] === 'string' ? o[k] : undefined;
const num = (o: JsonNode, k: string): number | undefined =>
  typeof o[k] === 'number' ? o[k] : undefined;
const obj = (o: JsonNode, k: string): JsonNode | undefined =>
  o[k] && typeof o[k] === 'object' ? (o[k] as JsonNode) : undefined;

/** Extract field and decl locations in `fileName` from a (possibly concatenated) JSON dump. */
export function extractAstInfo(dumpText: string, fileName: string): AstInfo {
  const out: AstInfo = { fields: [], decls: [] };
  const state: LocState = { file: '', line: 0, col: 0 };
  for (const doc of splitJsonDocuments(dumpText)) {
    let node: unknown;
    try {
      node = JSON.parse(doc);
    } catch {
      continue;
    }
    walk(node, { owner: '', qualified: '' }, state, fileName, out);
  }
  return out;
}

/** Convenience: only the field locations. */
export function extractFieldLocations(dumpText: string, fileName: string): FieldLocation[] {
  return extractAstInfo(dumpText, fileName).fields;
}

function walk(node: unknown, scope: Scope, state: LocState, fileName: string, out: AstInfo): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, scope, state, fileName, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const n = node as JsonNode;

  let mine: { line: number; col: number } | null = null;
  let span: { begin: number; end: number } | null = null;
  const kind = str(n, 'kind') ?? '';
  const name = str(n, 'name');
  // The scope children see: enclosing records give both an unqualified owner
  // and the qualified path (matching the layout dump's `A::S`); namespaces
  // extend only the qualified path.
  let next = scope;
  if (RECORD_KINDS.has(kind)) {
    const nm = name ?? '';
    next = { owner: nm, qualified: scope.qualified ? scope.qualified + '::' + nm : nm };
  } else if (NAMESPACE_KINDS.has(kind)) {
    const nm = name ?? '(anonymous namespace)';
    next = { owner: scope.owner, qualified: scope.qualified ? scope.qualified + '::' + nm : nm };
  }

  for (const key of Object.keys(n)) {
    const val = n[key];
    if (LOC_KEYS.has(key) && val && typeof val === 'object') {
      applyLoc(val as JsonNode, state);
      if (key === 'loc' && state.file.endsWith(fileName)) {
        mine = { line: state.line, col: state.col };
      }
      continue;
    }
    // `range` carries the declaration's extent. Its begin/end are applied in
    // document order (the dumper omits fields that repeat the previous
    // location), so this must not reorder or skip them.
    if (key === 'range' && val && typeof val === 'object') {
      const r = val as JsonNode;
      const b = obj(r, 'begin');
      const e = obj(r, 'end');
      if (b) applyLoc(b, state);
      const begin = state.line;
      const inFile = state.file.endsWith(fileName);
      if (e) applyLoc(e, state);
      if (inFile && begin > 0) span = { begin, end: Math.max(begin, state.line) };
      continue;
    }
    if (val && typeof val === 'object') walk(val, next, state, fileName, out);
  }
  const type = obj(n, 'type') ?? {};
  // Compiler-synthesised declarations are not written anywhere: a class's
  // injected-class-name repeats the record's own name with a one-token range,
  // which would otherwise shadow the real declaration.
  const implicit = n['isImplicit'] === true;
  if (mine && mine.line > 0 && name && !implicit) {
    if (RECORD_KINDS.has(kind)) {
      const d: DeclLocation = { kind: 'record', name, line: mine.line, col: mine.col };
      if (span) d.span = span;
      out.decls.push(d);
    } else if (kind === 'TypedefDecl' || kind === 'TypeAliasDecl') {
      const d: DeclLocation = { kind: 'typedef', name, line: mine.line, col: mine.col };
      const qt = str(type, 'qualType');
      if (qt !== undefined) d.qualType = qt;
      out.decls.push(d);
    }
  }
  if (kind === 'FieldDecl' && mine && mine.line > 0) {
    const f: FieldLocation = {
      owner: scope.owner,
      qualifiedOwner: scope.qualified,
      name: name ?? '',
      line: mine.line,
      col: mine.col,
      qualType: str(type, 'qualType') ?? '',
    };
    const ds = str(type, 'desugaredQualType');
    if (ds !== undefined) f.desugaredType = ds;
    const al = alignedAttrValue(n);
    if (al !== undefined) f.alignAttr = al;
    out.fields.push(f);
  }
}

/**
 * The evaluated value of an AlignedAttr on a declaration node, if any: clang
 * prints the constant it computed (`ConstantExpr.value`) inside the attribute.
 * `alignas(type)` forms have no constant and yield undefined.
 */
function alignedAttrValue(decl: JsonNode): number | undefined {
  const inner = decl['inner'];
  if (!Array.isArray(inner)) return undefined;
  for (const node of inner as JsonNode[]) {
    if (str(node, 'kind') !== 'AlignedAttr') continue;
    const args = node['inner'];
    if (!Array.isArray(args)) continue;
    for (const arg of args as JsonNode[]) {
      const v = str(arg, 'value');
      if (v !== undefined && /^\d+$/.test(v)) return Number(v);
    }
  }
  return undefined;
}

function applyLoc(loc: JsonNode, state: LocState): void {
  const spelling = obj(loc, 'spellingLoc');
  const expansion = obj(loc, 'expansionLoc');
  if (spelling || expansion) {
    if (spelling) applyLoc(spelling, state);
    if (expansion) applyLoc(expansion, state);
    return;
  }
  const file = str(loc, 'file');
  const line = num(loc, 'line');
  const col = num(loc, 'col');
  if (file !== undefined) state.file = file;
  if (line !== undefined) state.line = line;
  if (col !== undefined) state.col = col;
}

/** Split concatenated top-level JSON objects (skipping "Dumping X:" lines). */
export function splitJsonDocuments(text: string): string[] {
  const docs: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      if (depth > 0) inStr = true;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        docs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return docs;
}

// ------------------------------------------------------------- matching --

/** "ns::Outer::Inner<int>" -> "Inner"; anonymous -> "". */
export function unqualifiedName(name: string): string {
  // A record in an anonymous namespace is still a *named* record; drop the
  // `(anonymous namespace)::` qualifier so it resolves to its real name.
  name = name.replace(/\(anonymous namespace\)::/g, '');
  if (/\((?:anonymous|unnamed|lambda)/.test(name)) return '';
  // Drop every balanced <...> group (not just a trailing one) so a record
  // nested in a specialization, `Outer<int>::Inner`, resolves to `Inner`.
  let n = '';
  let depth = 0;
  for (const ch of name) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    else if (depth === 0) n += ch;
  }
  const i = n.lastIndexOf('::');
  return i >= 0 ? n.slice(i + 2) : n;
}

export type Locatable =
  Pick<Leaf, 'kind' | 'name' | 'owner'> | Pick<Group, 'kind' | 'name' | 'owner' | 'isBase'>;

/**
 * Map render-model items (leaves or groups) to source locations.
 * Returns Map itemIndex -> FieldLocation.
 */
export function matchItemsToLocations(
  items: Locatable[],
  locations: FieldLocation[],
): Map<number, FieldLocation> {
  const byQualified = new Map<string, FieldLocation>();
  const byOwnerName = new Map<string, FieldLocation>();
  const byName = new Map<string, FieldLocation[]>();
  for (const f of locations) {
    const qk = f.qualifiedOwner + '\0' + f.name;
    if (!byQualified.has(qk)) byQualified.set(qk, f);
    const k = f.owner + '\0' + f.name;
    if (!byOwnerName.has(k)) byOwnerName.set(k, f);
    const list = byName.get(f.name) ?? [];
    list.push(f);
    byName.set(f.name, list);
  }
  const result = new Map<number, FieldLocation>();
  items.forEach((item, i) => {
    if (item.kind === 'special' || ('isBase' in item && item.isBase) || !item.name) return;
    const name = item.name.startsWith('(') ? '' : item.name; // anonymous member
    // 1. Exact qualified-owner match (the layout dump's `A::S` == the AST's
    //    qualified scope), which disambiguates same-named records in different
    //    scopes. Then fall back to unqualified owner, then a unique-line by name.
    let loc = byQualified.get((item.owner || '') + '\0' + name);
    loc ??= byOwnerName.get(unqualifiedName(item.owner || '') + '\0' + name);
    if (!loc && /\((?:anon|unnamed)/.test(item.owner || '')) loc = byOwnerName.get('\0' + name);
    if (!loc && name) {
      const cands = byName.get(name);
      if (cands && new Set(cands.map((c) => c.line)).size === 1) loc = cands[0];
    }
    if (loc) result.set(i, loc);
  });
  return result;
}
