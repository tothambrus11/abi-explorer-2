// Extracts source lines of struct members from clang's `-ast-dump=json`
// output (as produced with `-ast-dump-filter=<record name>`).
//
// The JSON dumper omits "file"/"line" from a location when unchanged from the
// previously *written* location, so we replay the document in key order and
// keep running state. Locations appear under "loc", "range.begin/end",
// "spellingLoc" and "expansionLoc".

const LOC_KEYS = new Set(['loc', 'begin', 'end', 'spellingLoc', 'expansionLoc']);

/**
 * @returns [{ owner: 'Record', name: 'field', line: N }] for FieldDecls whose
 *          location is in `fileName`. `owner` is the unqualified name of the
 *          innermost enclosing record ('' for anonymous records).
 */
export function extractFieldLines(dumpText, fileName) {
  const out = [];
  const state = { file: '', line: 0 };
  for (const doc of splitJsonDocuments(dumpText)) {
    let node;
    try { node = JSON.parse(doc); } catch { continue; }
    walk(node, '', state, fileName, out);
  }
  return out;
}

const RECORD_KINDS = new Set(['RecordDecl', 'CXXRecordDecl', 'ClassTemplateSpecializationDecl',
  'ClassTemplatePartialSpecializationDecl']);

function walk(node, owner, state, fileName, out) {
  if (Array.isArray(node)) { for (const n of node) walk(n, owner, state, fileName, out); return; }
  if (!node || typeof node !== 'object') return;

  let myLine = null;
  let nextOwner = owner;
  if (RECORD_KINDS.has(node.kind)) nextOwner = node.name || '';

  for (const key of Object.keys(node)) {
    const val = node[key];
    if (LOC_KEYS.has(key) && val && typeof val === 'object') {
      applyLoc(val, state);
      if (key === 'loc' && node.kind === 'FieldDecl') {
        // Nested spelling/expansion locs (macros) were applied inside applyLoc.
        myLine = state.file.endsWith(fileName) ? state.line : null;
      }
      continue;
    }
    if (key === 'inner' || key === 'decl' || Array.isArray(val) || (val && typeof val === 'object')) {
      walk(val, nextOwner, state, fileName, out);
    }
  }
  if (node.kind === 'FieldDecl' && myLine !== null && myLine > 0) {
    out.push({ owner, name: node.name || '', line: myLine });
  }
}

function applyLoc(loc, state) {
  if (loc.spellingLoc || loc.expansionLoc) {
    if (loc.spellingLoc) applyLoc(loc.spellingLoc, state);
    if (loc.expansionLoc) applyLoc(loc.expansionLoc, state);
    return;
  }
  if (typeof loc.file === 'string') state.file = loc.file;
  if (typeof loc.line === 'number') state.line = loc.line;
}

/** Split concatenated top-level JSON objects (skipping "Dumping X:" lines). */
function splitJsonDocuments(text) {
  const docs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { if (depth > 0) inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) { docs.push(text.slice(start, i + 1)); start = -1; } }
  }
  return docs;
}

/**
 * Map render-model leaves to editor lines.
 * @returns Map leafIndex -> line
 */
export function matchLeavesToLines(leaves, fieldLines) {
  const byOwnerName = new Map();
  const byName = new Map();
  for (const f of fieldLines) {
    const k = f.owner + '\u0000' + f.name;
    if (!byOwnerName.has(k)) byOwnerName.set(k, f.line);
    if (!byName.has(f.name)) byName.set(f.name, []);
    byName.get(f.name).push(f.line);
  }
  const result = new Map();
  leaves.forEach((leaf, i) => {
    if (leaf.kind === 'special' || !leaf.name || leaf.name.startsWith('(')) return;
    const owner = unqualified(leaf.owner || '');
    let line = byOwnerName.get(owner + '\u0000' + leaf.name);
    if (line === undefined && /\(anon/.test(leaf.owner || '')) line = byOwnerName.get('\u0000' + leaf.name);
    if (line === undefined) {
      const cands = byName.get(leaf.name);
      if (cands && new Set(cands).size === 1) line = cands[0];
    }
    if (line !== undefined) result.set(i, line);
  });
  return result;
}

function unqualified(name) {
  // "ns::Outer::Inner<int>" -> "Inner"; anonymous -> ""
  if (/\((?:anonymous|unnamed)/.test(name)) return '';
  let n = name.replace(/<[^]*$/, ''); // drop template args (may contain ::)
  const i = n.lastIndexOf('::');
  return i >= 0 ? n.slice(i + 2) : n;
}
