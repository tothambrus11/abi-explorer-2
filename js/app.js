import { TARGET_GROUPS, DEFAULT_TRIPLE, C_STANDARDS, CXX_STANDARDS, DEFAULT_C_STD, DEFAULT_CXX_STD, EXAMPLES } from './targets.js';
import { parseRecordLayouts, isInternalRecord, isAnonymousRecord } from './layout-parser.js';
import { STATIC_PROBE_SOURCE, buildScalarTable, buildRecordIndex, buildProbeSource, failingProbeIndices, readProbeResults } from './size-resolver.js';
import { buildRenderModel } from './model.js';
import { assignColors, renderSummary, renderGrid, renderTable, createHoverController } from './render.js';
import { createEditor, parseDiagnostics } from './editor.js';
import { extractFieldLines, matchItemsToLines } from './ast-locations.js';

const $ = (id) => document.getElementById(id);

const state = {
  lang: 'c',
  std: DEFAULT_C_STD,
  triple: DEFAULT_TRIPLE,
  customTriple: '',
  pack: '',            // -fpack-struct=N
  msBitfields: false,
  shortEnums: false,
  shortWchar: false,
  wasiLibc: false,
  warnPadded: false,
  extraFlags: '',
  showInternal: false,
  selectedRecord: null,
  view: localStorage.getItem('abix-view') === 'stack' ? 'stack' : 'tabs',
};

let worker = null;
let workerReady = false;
let compileToken = 0;
let pendingCompile = false;
let compiling = false;
let nextMsgId = 1;
const inflight = new Map();

let editor = null;
let lastResult = null; // { records, userRecords, scalars, recordIndex, probeSizes, diagnostics }

// ------------------------------------------------------------- worker API --

function startWorker() {
  worker = new Worker(new URL('./clang-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      const pct = msg.total ? Math.round(100 * msg.done / msg.total) : 0;
      $('load-bar').style.width = pct + '%';
      $('load-text').textContent =
        msg.phase === 'download' ? `Downloading clang (wasm)… ${pct}% of ${(msg.total / 1048576).toFixed(0)} MB`
        : msg.phase === 'unpack' ? 'Unpacking…'
        : `Preparing clang… ${pct}%`;
    } else if (msg.type === 'ready') {
      workerReady = true;
      clangCached = true;
      updateOfflineStatus();
      $('loading').hidden = true;
      $('clang-version').textContent = msg.version.replace(/\(.*?\)\s*/, '');
      scheduleCompile(0);
    } else if (msg.type === 'result') {
      const h = inflight.get(msg.id);
      if (h) { inflight.delete(msg.id); h.resolve(msg); }
    } else if (msg.type === 'error') {
      if (msg.id && inflight.has(msg.id)) {
        const h = inflight.get(msg.id); inflight.delete(msg.id);
        h.reject(new Error(msg.message));
      } else {
        showStatus('error', 'clang failed to start: ' + msg.message);
        $('load-text').textContent = 'Failed to load clang: ' + msg.message;
      }
    }
  };
  worker.postMessage({ type: 'init' });
}

function compileInWorker(argv0, args, files) {
  const id = nextMsgId++;
  return new Promise((resolve, reject) => {
    inflight.set(id, { resolve, reject });
    worker.postMessage({ type: 'compile', id, argv0, args, files });
  });
}

// --------------------------------------------------------------- pipeline --

function activeTriple() {
  return state.triple === '__custom__' ? state.customTriple.trim() : state.triple;
}

function buildArgs(fileNames) {
  const isCxx = state.lang === 'c++';
  const args = [
    '--target=' + activeTriple(),
    '-x' + (isCxx ? 'c++' : 'c'),
    '-std=' + state.std,
    '-fsyntax-only',
    '-Xclang', '-fdump-record-layouts-complete',
    '-Wno-unused', '-fno-color-diagnostics',
  ];
  if (isCxx) args.push('-isystem/usr/include/c++/v1');
  if (state.wasiLibc) args.push('-isystem/usr/include/wasm32-wasip1');
  if (state.pack) args.push('-fpack-struct=' + state.pack);
  if (state.msBitfields) args.push('-mms-bitfields');
  if (state.shortEnums) args.push('-fshort-enums');
  if (state.shortWchar) args.push('-fshort-wchar');
  if (state.warnPadded) args.push('-Wpadded');
  if (state.extraFlags.trim()) args.push(...state.extraFlags.trim().split(/\s+/));
  args.push(...fileNames);
  return args;
}

async function runPipeline(token) {
  const isCxx = state.lang === 'c++';
  const ext = isCxx ? 'cc' : 'c';
  const argv0 = isCxx ? 'clang++' : 'clang';
  const source = editor.getValue();
  const mainFile = 'input.' + ext;
  const probeFile = 'abix_scalars.' + ext;

  // Pass 1: user TU + static scalar probes as a second TU.
  const r1 = await compileInWorker(argv0,
    buildArgs([mainFile, probeFile]),
    { [mainFile]: source, [probeFile]: STATIC_PROBE_SOURCE });
  if (token !== compileToken) return null;

  const records = parseRecordLayouts(r1.stdout);
  const scalars = buildScalarTable(records);
  const recordIndex = buildRecordIndex(records);
  const userRecords = records.filter(r => !isInternalRecord(r));
  const diagnostics = r1.stderr
    .split('\n')
    .filter(l => !l.includes(probeFile))
    .join('\n')
    .trim();

  // Collect unresolved type spellings across all displayable records.
  const probeSizes = new Map();
  let unresolved = new Set();
  for (const rec of userRecords) {
    const m = buildRenderModel(rec, scalars, recordIndex, probeSizes);
    for (const u of m.unresolved) unresolved.add(u);
  }

  // Pass 2 (optional): spelling probes, with up to 2 retries dropping probes
  // that fail to compile (inaccessible/unspellable types).
  let spellings = [...unresolved];
  for (let attempt = 0; attempt < 3 && spellings.length > 0; attempt++) {
    const probe2File = 'input_probe.' + ext;
    const { source: psrc, firstProbeLine, probes } = buildProbeSource(source, spellings);
    const r2 = await compileInWorker(argv0, buildArgs([probe2File]), { [probe2File]: psrc });
    if (token !== compileToken) return null;
    const recs2 = parseRecordLayouts(r2.stdout);
    for (const [spelling, pr] of readProbeResults(recs2, probes)) probeSizes.set(spelling, pr);
    if (r2.code === 0) break;
    const bad = failingProbeIndices(r2.stderr, probe2File, firstProbeLine, probes);
    if (bad.size === 0) break;
    spellings = probes.filter(p => !bad.has(p.index) && !probeSizes.has(p.spelling)).map(p => p.spelling);
  }

  return { code: r1.code, records, userRecords, scalars, recordIndex, probeSizes, diagnostics };
}

function scheduleCompile(delay = 500) {
  clearTimeout(scheduleCompile.timer);
  scheduleCompile.timer = setTimeout(() => { void compileNow(); }, delay);
}

async function compileNow() {
  if (!workerReady) return;
  if (compiling) { pendingCompile = true; return; }
  compiling = true;
  const token = ++compileToken;
  showStatus('busy', 'compiling…');
  try {
    const result = await runPipeline(token);
    if (result && token === compileToken) {
      lastResult = result;
      renderResult(result);
      updateHash();
      const nUser = result.userRecords.filter(r => !isAnonymousRecord(r)).length;
      if (result.code !== 0 && nUser === 0) {
        showStatus('error', 'compilation failed — see diagnostics');
      } else if (result.code !== 0) {
        showStatus('warn', 'compiled with errors — layouts may be incomplete');
      } else if (result.diagnostics) {
        showStatus('warn', 'compiled with warnings');
      } else {
        showStatus('ok', 'compiled');
      }
    }
  } catch (e) {
    showStatus('error', String(e.message || e));
  } finally {
    compiling = false;
    if (pendingCompile) { pendingCompile = false; void compileNow(); }
  }
}

// ---------------------------------------------------------------- render --

function displayableRecords(result) {
  return result.userRecords.filter(r => state.showInternal ||
    (!isAnonymousRecord(r) && !/^__/.test(r.name)));
}

function renderResult(result) {
  const recs = displayableRecords(result);
  const chipsBox = $('record-chips');
  chipsBox.textContent = '';
  const sectionsBox = $('sections');
  sectionsBox.textContent = '';

  if (recs.length === 0) {
    $('results').hidden = true;
    $('empty-note').hidden = false;
    $('empty-note').textContent = result.code === 0
      ? 'No struct/class/union definitions found. Define one in the editor — and make sure templates are instantiated.'
      : 'Compilation failed — fix the errors below.';
    renderDiagnostics(result.diagnostics);
    return;
  }
  $('empty-note').hidden = true;
  $('results').hidden = false;

  const stacked = state.view === 'stack';
  $('view-toggle').setAttribute('aria-pressed', String(stacked));
  $('view-toggle').title = stacked ? 'Show one record at a time (tabs)' : 'Show all records stacked';
  chipsBox.hidden = stacked;

  let selected = recs.find(r => recKey(r) === state.selectedRecord) ?? recs[recs.length - 1];
  state.selectedRecord = recKey(selected);

  if (!stacked) {
    for (const rec of recs) {
      const chip = document.createElement('button');
      chip.className = 'record-chip' + (rec === selected ? ' selected' : '');
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', String(rec === selected));
      chip.innerHTML = `<span class="rc-kind">${rec.kind}</span> ${escapeText(rec.name)} <span class="rc-size">${rec.sizeBytes} B</span>`;
      chip.addEventListener('click', () => {
        state.selectedRecord = recKey(rec);
        renderResult(result);
        updateHash();
      });
      chipsBox.appendChild(chip);
    }
  }

  // Reset editor-linked hover state before building sections.
  currentSections = [];
  currentLineInfo = new Map();
  editor.setMemberDots([]);
  editor.setLineInlay(null);
  editor.highlightLines([]);

  const shown = stacked ? recs : [selected];
  for (const rec of shown) {
    const model = buildRenderModel(rec, result.scalars, result.recordIndex, result.probeSizes);
    assignColors(model);
    const section = renderSection(rec, model, stacked);
    sectionsBox.appendChild(section.el);
    currentSections.push(section);
  }

  void updateMemberDots(currentSections);
  renderDiagnostics(result.diagnostics);
}

/** Build the DOM for one record (title, stat tiles, byte grid, table). */
function renderSection(rec, model, stacked) {
  const el = document.createElement('section');
  el.className = 'record-section';
  el.innerHTML = `
    <div class="record-head"><h2 class="record-title mono"></h2></div>
    <div class="summary"></div>
    <p class="estimate-note" hidden>≈ some field sizes could not be measured exactly and are estimated from neighbouring offsets.</p>
    <div class="grid-box"></div>
    <div class="table-box"></div>`;
  const title = el.querySelector('.record-title');
  title.textContent = `${rec.kind} ${rec.name}`;
  if (stacked) {
    title.id = 'rec-' + recKey(rec).replace(/[^\w]+/g, '-');
  }
  renderSummary(el.querySelector('.summary'), model);
  const gridBox = el.querySelector('.grid-box'), tableBox = el.querySelector('.table-box');
  const hover = createHoverController(gridBox, tableBox, $('tooltip'), model);
  const section = { rec, model, el, hover, leafLines: new Map() };
  // grid/table hover -> editor line highlight + inlay
  const baseEnter = hover.enter, baseLeave = hover.leave;
  hover.enter = (i, anchor, byte) => {
    baseEnter(i, anchor, byte);
    const line = section.leafLines.get(i);
    editor.highlightLines(line ? [line] : []);
    editor.setLineInlay(line, line ? describeItems([model.leaves[i]]) : null);
  };
  hover.leave = () => { baseLeave(); editor.highlightLines([]); editor.setLineInlay(null); };
  renderGrid(gridBox, model, hover);
  renderTable(tableBox, model, hover);
  el.querySelector('.estimate-note').hidden = !model.leaves.some(l => l.estimated);
  return section;
}

// ------------------------------------------------------- gutter dots --

let currentSections = [];        // [{ rec, model, el, hover, leafLines }]
let currentLineInfo = new Map(); // line -> [{ section, leaves:Set, items:[] }]
let dotsToken = 0;
const fieldLineCache = new Map(); // key -> fieldLines

async function fieldLinesForOwners(owners, token) {
  const isCxx = state.lang === 'c++';
  const ext = isCxx ? 'cc' : 'c';
  const mainFile = 'input.' + ext;
  const source = editor.getValue();
  const baseKey = [source, state.lang, state.std, activeTriple(), state.extraFlags].join('\u0000');
  const fieldLines = [];
  for (const owner of owners) {
    const key = baseKey + '\u0000' + owner;
    let lines = fieldLineCache.get(key);
    if (!lines) {
      const args = buildArgs([mainFile]).filter(a => a !== '-fdump-record-layouts-complete');
      const i = args.indexOf('-Xclang'); // the now-dangling -Xclang of the layout dump
      args.splice(i, 1, '-Xclang', '-ast-dump=json', '-Xclang', '-ast-dump-filter=' + owner);
      let r;
      try {
        r = await compileInWorker(isCxx ? 'clang++' : 'clang', args, { [mainFile]: source });
      } catch { return null; }
      if (token !== dotsToken) return null;
      lines = extractFieldLines(r.stdout, mainFile);
      if (fieldLineCache.size > 200) fieldLineCache.clear();
      fieldLineCache.set(key, lines);
    }
    fieldLines.push(...lines);
  }
  return fieldLines;
}

async function updateMemberDots(sections) {
  const token = ++dotsToken;
  // One filtered AST dump per distinct owner record across all shown
  // sections (records plus nested/base record types); anonymous members live
  // inside their parent's dump. Results are cached per (source, options, owner).
  const owners = new Set();
  for (const sec of sections) {
    owners.add(unqualifiedName(sec.rec.name));
    for (const l of sec.model.leaves) owners.add(unqualifiedName(l.owner || ''));
  }
  owners.delete('');
  const fieldLines = await fieldLinesForOwners([...owners].slice(0, 24), token);
  if (!fieldLines || token !== dotsToken) return;

  // Per line: for each section, which leaves to highlight and which items to
  // describe. A compound member (struct/union-typed field, anonymous struct)
  // contributes all of its leaves; its own offset/size/align is described.
  const info = new Map();
  for (const sec of sections) {
    const { model } = sec;
    const leafLines = matchItemsToLines(model.leaves, fieldLines);
    const groupLines = matchItemsToLines(model.groups, fieldLines);
    sec.leafLines = leafLines;
    const local = new Map();
    const at = (line) => { if (!local.has(line)) local.set(line, { section: sec, leaves: new Set(), items: [] }); return local.get(line); };
    for (const [gi, line] of groupLines) {
      const g = model.groups[gi];
      const e = at(line);
      for (const li of g.leafIndexes) e.leaves.add(li);
      e.items.push(g);
    }
    for (const [li, line] of leafLines) {
      const e = at(line);
      if (e.items.some(it => it.leafIndexes && it.leafIndexes.includes(li))) continue;
      e.leaves.add(li);
      e.items.push(model.leaves[li]);
    }
    for (const [line, e] of local) {
      if (!info.has(line)) info.set(line, []);
      info.get(line).push(e);
    }
  }
  currentLineInfo = info;

  editor.setMemberDots([...info].map(([line, entries]) => {
    const primary = primaryEntry(entries);
    const first = [...primary.leaves][0];
    return { line, leafIndexes: [...primary.leaves], colorClass: primary.section.model.leaves[first].colorClass };
  }));
  editor.refreshHover();
}

/** Prefer the section where the line's member is a direct (depth-0) member. */
function primaryEntry(entries) {
  return entries.find(e => e.items.some(it => (it.depth ?? it.path?.length ?? 0) === 0)) ?? entries[0];
}

function onEditorLineHover(line) {
  const entries = line !== null ? currentLineInfo.get(line) : null;
  for (const sec of currentSections) sec.hover.leave();
  if (!entries) return;
  for (const e of entries) e.section.hover.enterMany([...e.leaves], true);
  editor.highlightLines([line]);
  editor.setLineInlay(line, describeItems(primaryEntry(entries).items));
}

/** "offset 16 · 8 B · align 8" for one or more items on a line. */
function describeItems(items) {
  const one = items.length === 1;
  const it = items[0];
  if (one && it.kind === 'bitfield') {
    return `offset ${fmtOffset(it.offsetBits)} · ${it.sizeBits} bit${it.sizeBits === 1 ? '' : 's'}`;
  }
  const start = Math.min(...items.map(i => i.offsetBits));
  const ends = items.map(i => i.offsetBits + (i.sizeBits ?? 0));
  const end = Math.max(...ends);
  const sizeBytes = (end - start) / 8;
  const parts = [`offset ${fmtOffset(start)}`];
  if (one && it.sizeBits === null) parts.push('size ?');
  else parts.push(`${one && it.estimated ? '≈' : ''}${Number.isInteger(sizeBytes) ? sizeBytes : sizeBytes.toFixed(1)} B`);
  if (one && it.align) parts.push(`align ${it.align}`);
  else if (!one) parts.unshift(`${items.length} members ·`);
  return parts.join(' · ').replace('· ·', '·');
}

function fmtOffset(bits) {
  return bits % 8 === 0 ? String(bits / 8) : `${Math.floor(bits / 8)} +${bits % 8}b`;
}

function unqualifiedName(name) {
  if (/\((?:anonymous|unnamed|lambda)/.test(name)) return '';
  const n = name.replace(/<[^]*$/, '');
  const i = n.lastIndexOf('::');
  return i >= 0 ? n.slice(i + 2) : n;
}

function renderDiagnostics(text) {
  const ext = state.lang === 'c++' ? 'cc' : 'c';
  editor.setDiagnostics(parseDiagnostics(text || '', 'input.' + ext));
  const box = $('diagnostics');
  const wrap = $('diagnostics-wrap');
  if (!text) { wrap.hidden = true; box.textContent = ''; return; }
  wrap.hidden = false;
  box.textContent = text;
  wrap.open = /error/.test(text);
}

function recKey(rec) { return rec.kind + ' ' + rec.name; }

function escapeText(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function showStatus(kind, text) {
  const s = $('status');
  s.className = 'status ' + kind;
  s.textContent = text;
}

// --------------------------------------------------------------- controls --

function populateControls() {
  const targetSel = $('target');
  for (const group of TARGET_GROUPS) {
    const og = document.createElement('optgroup');
    og.label = group.label;
    for (const t of group.targets) {
      const opt = document.createElement('option');
      opt.value = t.triple;
      opt.textContent = `${t.label}  ·  ${t.triple}`;
      og.appendChild(opt);
    }
    targetSel.appendChild(og);
  }
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'Custom triple…';
  targetSel.appendChild(custom);
  targetSel.value = state.triple;

  populateStd();

  const exSel = $('example');
  EXAMPLES.forEach((ex, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = ex.name;
    exSel.appendChild(opt);
  });
}

function populateStd() {
  const stdSel = $('std');
  stdSel.textContent = '';
  const list = state.lang === 'c++' ? CXX_STANDARDS : C_STANDARDS;
  for (const s of list) {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    stdSel.appendChild(opt);
  }
  if (!list.includes(state.std)) state.std = state.lang === 'c++' ? DEFAULT_CXX_STD : DEFAULT_C_STD;
  stdSel.value = state.std;
}

function wireControls() {
  $('target').addEventListener('change', (e) => {
    state.triple = e.target.value;
    $('custom-triple-wrap').hidden = state.triple !== '__custom__';
    if (state.triple !== '__custom__') scheduleCompile(0);
  });
  $('custom-triple').addEventListener('input', (e) => {
    state.customTriple = e.target.value;
    scheduleCompile(700);
  });
  for (const radio of document.querySelectorAll('input[name="lang"]')) {
    radio.addEventListener('change', () => {
      state.lang = radio.value;
      editor.setLanguage(state.lang);
      populateStd();
      scheduleCompile(0);
    });
  }
  $('std').addEventListener('change', (e) => { state.std = e.target.value; scheduleCompile(0); });
  $('pack').addEventListener('change', (e) => { state.pack = e.target.value; scheduleCompile(0); });
  const bindCheck = (id, key) => $(id).addEventListener('change', (e) => {
    state[key] = e.target.checked; scheduleCompile(0);
  });
  bindCheck('ms-bitfields', 'msBitfields');
  bindCheck('short-enums', 'shortEnums');
  bindCheck('short-wchar', 'shortWchar');
  bindCheck('wasi-libc', 'wasiLibc');
  bindCheck('warn-padded', 'warnPadded');
  $('extra-flags').addEventListener('input', (e) => { state.extraFlags = e.target.value; scheduleCompile(800); });
  $('view-toggle').addEventListener('click', () => {
    state.view = state.view === 'stack' ? 'tabs' : 'stack';
    localStorage.setItem('abix-view', state.view);
    if (lastResult) renderResult(lastResult);
    updateHash();
  });
  $('show-internal').addEventListener('change', (e) => {
    state.showInternal = e.target.checked;
    if (lastResult) renderResult(lastResult);
  });

  $('example').addEventListener('change', (e) => {
    const ex = EXAMPLES[Number(e.target.value)];
    if (!ex) return;
    editor.setValue(ex.source);
    if (ex.lang !== state.lang) {
      state.lang = ex.lang;
      editor.setLanguage(state.lang);
      document.querySelector(`input[name="lang"][value="${ex.lang}"]`).checked = true;
      populateStd();
    }
    state.selectedRecord = null;
    scheduleCompile(0);
    e.target.value = '';
  });

  $('share').addEventListener('click', async () => {
    updateHash();
    try {
      await navigator.clipboard.writeText(location.href);
      showStatus('ok', 'link copied');
    } catch {
      showStatus('warn', 'copy failed — copy the address bar URL');
    }
  });
}

// -------------------------------------------------------------- URL state --

function updateHash() {
  const data = {
    v: 1, s: editor.getValue(), l: state.lang, std: state.std,
    t: state.triple, ct: state.customTriple,
    p: state.pack, mb: +state.msBitfields, se: +state.shortEnums,
    sw: +state.shortWchar, wl: +state.wasiLibc, wp: +state.warnPadded,
    x: state.extraFlags, r: state.selectedRecord, vw: state.view,
  };
  const enc = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  history.replaceState(null, '', '#' + enc);
}

let pendingSource = '';

function loadHash() {
  if (!location.hash || location.hash.length < 2) return false;
  try {
    const b64 = location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (data.v !== 1) return false;
    pendingSource = data.s ?? '';
    state.lang = data.l === 'c++' ? 'c++' : 'c';
    state.std = data.std || (state.lang === 'c++' ? DEFAULT_CXX_STD : DEFAULT_C_STD);
    state.triple = data.t || DEFAULT_TRIPLE;
    state.customTriple = data.ct || '';
    state.pack = data.p || '';
    state.msBitfields = !!data.mb; state.shortEnums = !!data.se;
    state.shortWchar = !!data.sw; state.wasiLibc = !!data.wl; state.warnPadded = !!data.wp;
    state.extraFlags = data.x || '';
    state.selectedRecord = data.r || null;
    if (data.vw === 'stack' || data.vw === 'tabs') state.view = data.vw;
    return true;
  } catch {
    return false;
  }
}

function applyStateToControls() {
  document.querySelector(`input[name="lang"][value="${state.lang}"]`).checked = true;
  populateStd();
  $('target').value = state.triple;
  $('custom-triple-wrap').hidden = state.triple !== '__custom__';
  $('custom-triple').value = state.customTriple;
  $('pack').value = state.pack;
  $('ms-bitfields').checked = state.msBitfields;
  $('short-enums').checked = state.shortEnums;
  $('short-wchar').checked = state.shortWchar;
  $('wasi-libc').checked = state.wasiLibc;
  $('warn-padded').checked = state.warnPadded;
  $('extra-flags').value = state.extraFlags;
  $('show-internal').checked = state.showInternal;
}

// ------------------------------------------------------------------ init --

populateControls();
const restored = loadHash();
if (!restored) pendingSource = EXAMPLES[0].source;
editor = createEditor($('editor'), {
  value: pendingSource,
  language: state.lang === 'c++' ? 'cpp' : 'c',
  onChange: () => scheduleCompile(600),
});
editor.onLineHover(onEditorLineHover);
applyStateToControls();
wireControls();
startWorker();
registerServiceWorker();

// ------------------------------------------------------------------- PWA --

let clangCached = false;

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: './' });
    // A new worker installed while the page is open: activate it now so the
    // next reload gets the fresh shell.
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          w.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });
    await navigator.serviceWorker.ready;
    updateOfflineStatus();
  } catch (e) {
    console.warn('service worker registration failed', e);
  }
}

function updateOfflineStatus() {
  const controlled = !!navigator.serviceWorker?.controller;
  $('offline-status').hidden = !(controlled && clangCached);
}
