// Rendering: summary tiles, byte-grid memory map, and field table for one
// record's layout model. Identity is carried by color + linked hover between
// grid cells and table rows (color is never the only channel: the table is
// always present and hover names the field).

const PALETTE_SIZE = 8;
const GRID_LIMIT_BYTES = 2048; // above this, draw the proportional bar only

const fmt = new Intl.NumberFormat('en-US');

export function assignColors(model) {
  let i = 0;
  for (const leaf of model.leaves) {
    if (leaf.kind === 'special') leaf.colorClass = 'c-special';
    else leaf.colorClass = 'c-' + (i++ % PALETTE_SIZE + 1);
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function offsetLabel(bits) {
  const bytes = Math.floor(bits / 8), bit = bits % 8;
  return bit === 0 ? String(bytes) : `${bytes} +${bit}b`;
}

function sizeLabel(leaf) {
  if (leaf.kind === 'bitfield') return `${leaf.sizeBits} bit${leaf.sizeBits === 1 ? '' : 's'}`;
  const bytes = leaf.sizeBits / 8;
  return `${fmt.format(bytes)} B`;
}

function pathLabel(leaf) {
  return [...leaf.path, leaf.name].join(' :: ');
}

// ---------------------------------------------------------------- summary --

export function renderSummary(container, model) {
  container.textContent = '';
  const rec = model.record;
  const tiles = [
    { label: 'size', value: fmt.format(rec.sizeBytes), unit: 'bytes' },
    { label: 'alignment', value: fmt.format(rec.align), unit: 'bytes' },
    {
      label: 'padding', value: fmt.format(model.paddingBytes),
      unit: rec.sizeBytes ? `bytes · ${Math.round(100 * model.paddingBytes / rec.sizeBytes)}%` : 'bytes',
      warn: model.paddingBytes > 0,
    },
  ];
  for (const t of tiles) {
    const tile = el('div', 'stat-tile' + (t.warn ? ' stat-warn' : ''));
    tile.appendChild(el('div', 'stat-label', t.label));
    const v = el('div', 'stat-value', t.value);
    tile.appendChild(v);
    tile.appendChild(el('div', 'stat-unit', t.unit));
    container.appendChild(tile);
  }
  const extras = [];
  if (rec.dsize !== undefined && rec.dsize !== rec.sizeBytes) extras.push(`dsize ${rec.dsize}`);
  if (rec.nvsize !== undefined && rec.nvsize !== rec.sizeBytes) extras.push(`nvsize ${rec.nvsize}`);
  if (rec.nvalign !== undefined && rec.nvalign !== rec.align) extras.push(`nvalign ${rec.nvalign}`);
  if (rec.preferredalign !== undefined && rec.preferredalign !== rec.align) extras.push(`preferred align ${rec.preferredalign}`);
  if (extras.length) {
    const chip = el('div', 'stat-extras', extras.join(' · '));
    chip.title = 'dsize: size without tail padding · nvsize/nvalign: size/alignment excluding virtual bases';
    container.appendChild(chip);
  }
}

// ------------------------------------------------------------------- grid --

function coverageMap(model) {
  // byte index -> array of leaves covering it; bit index -> bitfield leaf
  const bytes = new Map();
  const hasBits = new Set(); // byte indices that need bit-level rendering
  for (const leaf of model.leaves) {
    if (leaf.sizeBits === 0) continue;
    const from = Math.floor(leaf.offsetBits / 8);
    const to = Math.ceil((leaf.offsetBits + leaf.sizeBits) / 8);
    for (let b = from; b < to; b++) {
      if (!bytes.has(b)) bytes.set(b, []);
      bytes.get(b).push(leaf);
      if (leaf.kind === 'bitfield') hasBits.add(b);
    }
  }
  return { bytes, hasBits };
}

export function renderGrid(container, model, hover) {
  container.textContent = '';
  const size = model.record.sizeBytes;
  if (size === 0) {
    container.appendChild(el('div', 'grid-note', 'Zero-size record.'));
    return;
  }
  if (size > GRID_LIMIT_BYTES) {
    renderBar(container, model, hover);
    return;
  }

  const bpr = size <= 64 ? 8 : 16;
  const { bytes, hasBits } = coverageMap(model);

  const grid = el('div', 'byte-grid');
  grid.style.setProperty('--bpr', bpr);

  // column header
  grid.appendChild(el('div', 'bg-corner'));
  for (let c = 0; c < bpr; c++) grid.appendChild(el('div', 'bg-col', '+' + c));

  const rows = Math.ceil(size / bpr);
  for (let r = 0; r < rows; r++) {
    grid.appendChild(el('div', 'bg-row', String(r * bpr)));
    for (let c = 0; c < bpr; c++) {
      const b = r * bpr + c;
      if (b >= size) { grid.appendChild(el('div', 'bg-cell bg-void')); continue; }
      const cell = el('div', 'bg-cell');
      cell.dataset.byte = b;
      const cover = bytes.get(b) || [];

      if (hasBits.has(b)) {
        cell.classList.add('bg-bits');
        for (let bit = 0; bit < 8; bit++) {
          const bitIdx = b * 8 + bit;
          const owner = cover.find(l =>
            bitIdx >= l.offsetBits && bitIdx < l.offsetBits + l.sizeBits &&
            (l.kind === 'bitfield' || true));
          const bitCell = el('div', 'bg-bit ' + (owner ? owner.colorClass : 'bg-pad'));
          if (owner) {
            bitCell.dataset.leaf = model.leaves.indexOf(owner);
            if (bitIdx === owner.offsetBits) bitCell.classList.add('leaf-start');
          }
          cell.appendChild(bitCell);
        }
      } else if (cover.length === 0) {
        cell.classList.add('bg-pad');
        cell.dataset.pad = '1';
      } else if (cover.length === 1) {
        const leaf = cover[0];
        cell.classList.add(leaf.colorClass);
        cell.dataset.leaf = model.leaves.indexOf(leaf);
        if (leaf.estimated) cell.classList.add('estimated');
        if (Math.floor(leaf.offsetBits / 8) === b) cell.classList.add('leaf-start');
        if (Math.ceil((leaf.offsetBits + leaf.sizeBits) / 8) === b + 1) cell.classList.add('leaf-end');
      } else {
        // union overlap: stripe up to 3 colors
        cell.classList.add('bg-multi');
        const colors = cover.slice(0, 3).map(l => `var(--${l.colorClass})`);
        cell.style.background = `repeating-linear-gradient(45deg, ${colors.map((c2, i) => `${c2} ${i * 4}px, ${c2} ${(i + 1) * 4}px`).join(', ')})`;
        cell.dataset.leaf = model.leaves.indexOf(cover[0]);
        cell.dataset.multi = cover.map(l => model.leaves.indexOf(l)).join(',');
        if (cover.some(l => Math.floor(l.offsetBits / 8) === b)) cell.classList.add('leaf-start');
      }
      grid.appendChild(cell);
    }
  }
  container.appendChild(grid);
  wireGridHover(grid, model, hover);
}

function renderBar(container, model, hover) {
  const note = el('div', 'grid-note',
    `Struct is ${fmt.format(model.record.sizeBytes)} bytes — showing a proportional map instead of a byte grid.`);
  container.appendChild(note);
  const bar = el('div', 'prop-bar');
  const size = model.sizeBits;
  const segments = [...model.leaves.map(l => ({ ...l, isPad: false }))]
    .filter(l => l.sizeBits > 0)
    .sort((a, b) => a.offsetBits - b.offsetBits);
  for (const seg of segments) {
    const span = el('div', 'prop-seg ' + seg.colorClass);
    span.style.flexGrow = String(Math.max(seg.sizeBits / size, 0.002) * 1000);
    span.dataset.leaf = model.leaves.indexOf(seg);
    bar.appendChild(span);
  }
  for (const pad of model.paddings) {
    const span = el('div', 'prop-seg bg-pad');
    span.style.flexGrow = String(Math.max((pad.end - pad.start) * 8 / size, 0.002) * 1000);
    span.dataset.pad = '1';
    // insert in order: rebuild sorted
    span.dataset.offset = pad.start * 8;
    bar.appendChild(span);
  }
  // order children by offset
  [...bar.children]
    .sort((a, b) => leafOffset(a, model) - leafOffset(b, model))
    .forEach(c => bar.appendChild(c));
  container.appendChild(bar);
  wireGridHover(bar, model, hover);
}

function leafOffset(node, model) {
  if (node.dataset.leaf !== undefined) return model.leaves[Number(node.dataset.leaf)].offsetBits;
  return Number(node.dataset.offset || 0);
}

function wireGridHover(root, model, hover) {
  root.addEventListener('mouseover', (ev) => {
    const t = ev.target.closest('[data-leaf], [data-pad]');
    if (!t || !root.contains(t)) return;
    if (t.dataset.leaf !== undefined) {
      hover.enter(Number(t.dataset.leaf), t, byteOf(t));
    } else {
      hover.enterPad(t, byteOf(t));
    }
  });
  root.addEventListener('mouseout', (ev) => {
    const t = ev.target.closest('[data-leaf], [data-pad]');
    if (t) hover.leave();
  });
}

function byteOf(node) {
  const cell = node.closest('[data-byte]');
  return cell ? Number(cell.dataset.byte) : null;
}

// ------------------------------------------------------------------ table --

export function renderTable(container, model, hover, ptrBits) {
  container.textContent = '';
  const table = el('table', 'field-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['', 'Field', 'Type', 'Offset', 'Size', 'Padding after']) hr.appendChild(el('th', null, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');

  // Attribute each padding run to the single leaf that ends closest before it.
  const padAfterLeaf = new Map(); // leaf index -> padding bytes
  for (const p of model.paddings) {
    let best = -1, bestEnd = -1;
    model.leaves.forEach((leaf, i) => {
      const end = leaf.offsetBits + leaf.sizeBits;
      if (end <= p.start * 8 && end > bestEnd) { bestEnd = end; best = i; }
    });
    if (best >= 0) padAfterLeaf.set(best, (padAfterLeaf.get(best) || 0) + (p.end - p.start));
  }

  const addRow = (leafIndex, leaf) => {
    const tr = el('tr');
    tr.dataset.leaf = leafIndex;
    const chipCell = el('td', 'col-chip');
    const chip = el('span', 'chip ' + leaf.colorClass);
    chipCell.appendChild(chip);
    tr.appendChild(chipCell);

    const nameCell = el('td', 'col-name');
    nameCell.style.paddingLeft = (8 + leaf.depth * 16) + 'px';
    if (leaf.path.length) {
      const crumb = el('span', 'crumb', leaf.path.join(' » ') + ' » ');
      nameCell.appendChild(crumb);
    }
    nameCell.appendChild(el('span', 'fname', leaf.name));
    tr.appendChild(nameCell);

    tr.appendChild(el('td', 'col-type', leaf.kind === 'special' ? '—' : leaf.type));
    tr.appendChild(el('td', 'col-num', offsetLabel(leaf.offsetBits)));
    tr.appendChild(el('td', 'col-num' + (leaf.estimated ? ' est' : ''),
      (leaf.estimated ? '≈ ' : '') + sizeLabel(leaf)));

    const pad = padAfterLeaf.get(leafIndex);
    const padCell = el('td', 'col-num col-pad', pad ? `+${pad} B` : '');
    tr.appendChild(padCell);

    tbody.appendChild(tr);
  };

  model.leaves.forEach((leaf, i) => addRow(i, leaf));

  for (const marker of model.markers) {
    const tr = el('tr', 'marker-row');
    tr.appendChild(el('td', 'col-chip'));
    const nameCell = el('td', 'col-name');
    nameCell.style.paddingLeft = (8 + marker.path.length * 16) + 'px';
    const label = marker.kind === 'empty-base' ? `${marker.name} (empty base)` :
      marker.kind === 'zero-bitfield' ? `${marker.type} :0 (unit break)` : marker.name;
    nameCell.appendChild(el('span', 'fname muted', label));
    tr.appendChild(nameCell);
    tr.appendChild(el('td', 'col-type', ''));
    tr.appendChild(el('td', 'col-num', offsetLabel(marker.offsetBits)));
    tr.appendChild(el('td', 'col-num', '0'));
    tr.appendChild(el('td', 'col-num', ''));
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  container.appendChild(table);

  tbody.addEventListener('mouseover', (ev) => {
    const tr = ev.target.closest('tr[data-leaf]');
    if (tr) hover.enter(Number(tr.dataset.leaf), tr, null);
  });
  tbody.addEventListener('mouseout', (ev) => {
    const tr = ev.target.closest('tr[data-leaf]');
    if (tr) hover.leave();
  });
}

// ---------------------------------------------------------------- tooltip --

export function createHoverController(gridRoot, tableRoot, tooltip, model) {
  const clear = () => {
    for (const n of document.querySelectorAll('.hovered')) n.classList.remove('hovered');
    tooltip.hidden = true;
  };
  return {
    enter(leafIndex, anchor, byte) {
      clear();
      const leaf = model.leaves[leafIndex];
      if (!leaf) return;
      for (const n of gridRoot.querySelectorAll(`[data-leaf="${leafIndex}"]`)) n.classList.add('hovered');
      for (const n of gridRoot.querySelectorAll('[data-multi]')) {
        if (n.dataset.multi.split(',').map(Number).includes(leafIndex)) n.classList.add('hovered');
      }
      for (const n of tableRoot.querySelectorAll(`tr[data-leaf="${leafIndex}"]`)) n.classList.add('hovered');
      const lines = [
        `<strong>${escapeHtml(pathLabel(leaf))}</strong>`,
        leaf.type ? escapeHtml(leaf.type) : '',
        `offset ${offsetLabel(leaf.offsetBits)} · ${leaf.estimated ? '≈' : ''}${sizeLabel(leaf)}`,
      ];
      if (byte !== null) lines.push(`byte ${byte}`);
      showTooltip(tooltip, anchor, lines.filter(Boolean).join('<br>'));
    },
    enterPad(anchor, byte) {
      clear();
      showTooltip(tooltip, anchor,
        `<strong>padding</strong><br>${byte !== null ? 'byte ' + byte : 'unused bytes'}`);
    },
    leave: clear,
  };
}

function showTooltip(tooltip, anchor, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const r = anchor.getBoundingClientRect();
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
  let y = r.top - th - 8;
  if (y < 8) y = r.bottom + 8;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
