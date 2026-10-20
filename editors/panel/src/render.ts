// The layout panel, drawn as the web explorer's layout view is: a tab per
// record, then for the one shown its size tiles, its byte grid (bits where
// bit-fields are, stripes where union members overlap) and its member table,
// nested, every compound member starting shut.
//
// Plain DOM, no framework: the whole panel is one function from a layout
// result to elements, re-run on every update, and a few listeners that light
// up a member's bytes and rows together and tell the host which source to mark.

import type {
  GroupView,
  LayoutResult,
  LeafView,
  Range,
  RecordView,
} from '@abi-explorer/shared/protocol';
import { formatOffset, formatSizeShort } from '@abi-explorer/shared/format';
import {
  bytesPerRow,
  contextNotes,
  GRID_LIMIT,
  gridCells,
  leafName,
  leafSize,
  nodeId,
  paddingAfter,
  recordSummary,
  visibleRows,
} from '@abi-explorer/shared/layoutModel';

export interface PanelActions {
  /** Puts the caret on a range: in this document, or in the file `uri` names. */
  reveal(range: Range, uri?: string): void;
  /** Marks these ranges in the document as the web explorer marks a hovered member; none clears. */
  mark(ranges: Range[]): void;
  /** Puts text on the clipboard; the host does it, a webview may not. */
  copy(text: string): void;
  /** The records on screen, whose members the editor marks with dots as the web does. */
  shown(recordIds: number[]): void;
}

export interface PanelState {
  /**
   * The record picked with a tab. It holds while the caret stays in the record
   * it was in then; moving to another hands the choice back to the caret.
   */
  choice: { recordId: number; caretRecordId: number | null } | null;
  /** Every record at once, as the web's stacked view, instead of one tab at a time. */
  stacked: boolean;
  /** The table rows opened, per record name; everything starts shut. */
  opened: Map<string, Set<string>>;
}

export function initialState(): PanelState {
  return { choice: null, stacked: false, opened: new Map() };
}

/** What is lit up: these leaves, and these bytes (a compound member's own padding). */
interface Lit {
  leaves: Set<number>;
  bytes: [number, number][];
}

const NOTHING: Lit = { leaves: new Set(), bytes: [] };

/** Tooltips over table headings, as the web explorer's. */
const HEAD = {
  offset: 'Bytes from the start of this record to where the member begins.',
  size:
    'Bytes the member occupies inside this record. Not always sizeof(its type): a base can have ' +
    'its tail padding reused, an empty member sharing an address occupies none, and a bit-field ' +
    'is measured in bits.',
  align: 'The address boundary this member must start on.',
  pad: 'Bytes between the end of this member and the start of the next one.',
};

/** One nesting level of the table, in pixels; the CSS's `--indent` too. */
const INDENT = 16;

export function renderPanel(
  root: HTMLElement,
  result: LayoutResult,
  state: PanelState,
  actions: PanelActions,
): void {
  const caretRecordId = result.selection?.recordId ?? null;
  if (state.choice && state.choice.caretRecordId !== caretRecordId) state.choice = null;
  const shownId = state.choice?.recordId ?? caretRecordId ?? result.records[0]?.id ?? null;
  root.replaceChildren();
  const tip = element('div', 'tip');
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;

  if (result.records.length === 0) {
    root.append(
      element(
        'p',
        'empty',
        result.message ?? (result.state === 'analyzing' ? 'Analyzing…' : 'No layouts yet.'),
      ),
    );
    return;
  }
  if (result.message) root.append(element('p', 'notice', result.message));
  const rerender = () => {
    renderPanel(root, result, state, actions);
  };

  const bar = element('div', 'bar');
  const chips = element('div', 'chips');
  chips.setAttribute('role', 'tablist');
  chips.hidden = state.stacked;
  for (const record of result.records) {
    const selected = record.id === shownId;
    const chip = element('button', selected ? 'chip selected' : 'chip');
    chip.type = 'button';
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(selected));
    chip.append(
      element('span', 'kind', record.kind),
      ` ${record.name} `,
      element('span', 'size', formatSizeShort(record.sizeBits)),
    );
    chip.addEventListener('click', () => {
      // As the web's tab: the caret goes to the declaration too.
      state.choice = { recordId: record.id, caretRecordId };
      if (record.nameRange) actions.reveal(record.nameRange);
      rerender();
    });
    chips.append(chip);
  }
  const toggle = element('button', 'icon-button', state.stacked ? '▭' : '☰');
  toggle.type = 'button';
  toggle.title = state.stacked ? 'Show one record at a time (tabs)' : 'Show all records stacked';
  toggle.setAttribute('aria-pressed', String(state.stacked));
  toggle.addEventListener('click', () => {
    state.stacked = !state.stacked;
    rerender();
  });
  bar.append(chips, toggle);
  root.append(bar);

  const sections = element('div', 'sections');
  const shown = state.stacked
    ? result.records
    : result.records.filter((record) => record.id === shownId);
  actions.shown(shown.map((record) => record.id));
  for (const record of shown) {
    const selection = result.selection?.recordId === record.id ? result.selection : null;
    const memberIndex = selection?.memberIndex ?? null;
    const member = memberIndex === null ? null : record.members[memberIndex];
    const caretLit: Lit = member
      ? { leaves: new Set(member.leaves), bytes: member.group === null ? [] : [extent(member)] }
      : NOTHING;
    sections.append(
      recordSection(record, caretLit, state, tip, {
        ...actions,
        inspect: (group) => {
          const target = result.records.find((other) => other.id === group.recordId);
          if (target) {
            state.choice = { recordId: target.id, caretRecordId };
            if (target.nameRange) actions.reveal(target.nameRange);
            rerender();
          } else if (group.declaration) {
            actions.reveal(group.declaration.range, group.declaration.uri);
          }
        },
        rerender,
      }),
    );
  }
  root.append(sections);

  if (result.context) {
    const notes = contextNotes(result.context);
    if (result.state === 'analyzing') notes.push('updating…');
    root.append(element('p', 'context', notes.join(' · ')));
  }
  root.append(tip);
}

interface SectionActions extends PanelActions {
  /** Open the record a compound member is an instance of. */
  inspect(group: GroupView): void;
  rerender(): void;
}

function recordSection(
  record: RecordView,
  caretLit: Lit,
  state: PanelState,
  tip: HTMLElement,
  actions: SectionActions,
): HTMLElement {
  const section = element('section', 'record');
  section.append(element('h2', 'title', `${record.kind} ${record.name}`), summary(record));
  const grid = byteGrid(record);
  section.append(grid.element);
  const table = fieldTable(record, state, actions);
  section.append(table);
  if (record.text) {
    const copy = element('button', 'copy', 'Copy as text');
    copy.type = 'button';
    copy.title = 'Copy the byte map and member table as text';
    copy.addEventListener('click', () => {
      actions.copy(`${record.kind} ${record.name} · ${recordSummary(record)}\n\n${record.text!}`);
    });
    section.append(copy);
  }

  const { layout } = record;
  const light = (lit: Lit) => {
    const inBytes = (byte: number) => lit.bytes.some(([from, to]) => byte >= from && byte < to);
    for (const node of section.querySelectorAll<HTMLElement>('[data-leaves]')) {
      const leaves = node.dataset.leaves ? node.dataset.leaves.split(' ').map(Number) : [];
      let on: boolean;
      if (node.dataset.byte !== undefined && leaves.length === 0) {
        on = inBytes(Number(node.dataset.byte));
      } else if (node.dataset.shut === 'true' || node.classList.contains('cell')) {
        on = leaves.some((index) => lit.leaves.has(index));
      } else {
        on = leaves.length > 0 && leaves.every((index) => lit.leaves.has(index));
      }
      node.classList.toggle('hovered', on);
    }
  };
  const ranges = (leaves: number[], group: GroupView | null): Range[] =>
    group?.nameRange
      ? [group.nameRange]
      : leaves.flatMap((index) => {
          const range = layout.leaves[index]?.nameRange;
          return range ? [range] : [];
        });

  let hovering = false;
  section.addEventListener('pointerover', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-hover]');
    if (!target) return;
    hovering = true;
    const leaves = target.dataset.leaves ? target.dataset.leaves.split(' ').map(Number) : [];
    const group = target.dataset.group ? layout.groups[Number(target.dataset.group)]! : null;
    const byte = target.dataset.byte === undefined ? null : Number(target.dataset.byte);
    // A group lights its whole extent, its own padding included; a padding cell only its tooltip.
    light({
      leaves: new Set(leaves),
      bytes: group ? [extent(group)] : [],
    });
    actions.mark(ranges(leaves, group));
    showTip(tip, target, tooltipLines(record, leaves, group, byte));
  });
  section.addEventListener('pointerleave', () => {
    if (!hovering) return;
    hovering = false;
    tip.hidden = true;
    light(caretLit);
    actions.mark([]);
  });
  light(caretLit);
  return section;
}

/** The web's tiles: sizeof, alignof, padding, and the ABI's other sizes where they differ. */
function summary(record: RecordView): HTMLElement {
  const box = element('div', 'summary');
  const size = record.sizeBits / 8;
  const tile = (label: string, value: string, unit: string, title: string, warn = false) => {
    const node = element('div', warn ? 'tile warn' : 'tile');
    node.title = title;
    node.append(
      element('div', 'label', label),
      element('div', 'value', value),
      element('div', 'unit', unit),
    );
    return node;
  };
  const padding = record.paddingBytes;
  box.append(
    tile(
      'sizeof',
      String(size),
      'bytes',
      'sizeof: the bytes one object of this type takes, including any trailing padding. An array element is spaced by exactly this much.',
    ),
    tile(
      'alignof',
      String(record.alignBits / 8),
      'bytes',
      'alignof: the address boundary an object of this type must start on.',
    ),
    tile(
      'padding',
      padding === null ? '-' : String(padding),
      padding === null
        ? 'not measured'
        : `bytes${size ? ` · ${Math.round((100 * padding) / size)}%` : ''}`,
      padding === null
        ? 'Not measured: the record is too large to scan byte by byte.'
        : 'Bytes inside sizeof that no member occupies, inserted to keep members aligned.',
      padding !== null && padding > 0,
    ),
  );
  const extras: string[] = [];
  if (record.dataSizeBits !== record.sizeBits) extras.push(`dsize ${record.dataSizeBits / 8} B`);
  if (record.nonVirtualSizeBits !== record.sizeBits) {
    extras.push(`nvsize ${record.nonVirtualSizeBits / 8} B`);
  }
  if (record.nonVirtualAlignBits !== record.alignBits) {
    extras.push(`nvalign ${record.nonVirtualAlignBits / 8} B`);
  }
  if (record.preferredAlignBits !== record.alignBits) {
    extras.push(`preferred align ${record.preferredAlignBits / 8} B`);
  }
  if (extras.length) {
    const node = element('div', 'extras', extras.join(' · '));
    node.title =
      'dsize: size without trailing padding, i.e. how much a derived class may reuse. nvsize / nvalign: size and alignment excluding virtual bases. preferred align: the alignment the ABI would like, where it exceeds the required one.';
    box.append(node);
  }
  return box;
}

function byteGrid(record: RecordView): { element: HTMLElement } {
  const size = record.sizeBits / 8;
  const { layout } = record;
  if (size === 0) return { element: element('div', 'note', 'Zero-size record.') };
  if (size > GRID_LIMIT) {
    const box = element('div');
    box.append(
      element(
        'div',
        'note',
        `Struct is ${size.toLocaleString()} bytes, so this is a proportional map instead of a byte grid.`,
      ),
    );
    const bar = element('div', 'proportional');
    bar.setAttribute('role', 'img');
    const segments = [
      ...layout.leaves.map((leaf, index) => ({
        offset: leaf.offsetBits,
        length: leaf.sizeBits,
        leaf: index,
      })),
      ...layout.paddings.map((run) => ({
        offset: run.startBits,
        length: run.endBits - run.startBits,
        leaf: null as number | null,
      })),
    ]
      .filter((segment) => segment.length > 0)
      .sort((a, b) => a.offset - b.offset);
    for (const segment of segments) {
      const node = element('div', segment.leaf === null ? 'segment pad' : 'segment');
      if (segment.leaf !== null) {
        node.style.background = `var(--${layout.leaves[segment.leaf]!.color})`;
      }
      node.style.flexGrow = String(Math.max(segment.length / record.sizeBits, 0.002) * 1000);
      node.dataset.hover = '';
      node.dataset.leaves = segment.leaf === null ? '' : String(segment.leaf);
      if (segment.leaf === null) node.dataset.byte = String(segment.offset / 8);
      bar.append(node);
    }
    box.append(bar);
    return { element: box };
  }

  const perRow = bytesPerRow(size);
  const box = element('div', 'grid-box');
  const grid = element('div', 'grid');
  grid.style.setProperty('--bpr', String(perRow));
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', 'byte grid');
  grid.append(element('div', 'corner'));
  for (let column = 0; column < perRow; column++) {
    grid.append(element('div', 'col', `+${column}`));
  }
  const cells = gridCells(record);
  const rows = Math.ceil(size / perRow);
  for (let row = 0; row < rows; row++) {
    grid.append(element('div', 'row', String(row * perRow)));
    for (let column = 0; column < perRow; column++) {
      const byte = row * perRow + column;
      const cell = cells[byte];
      if (!cell) {
        grid.append(element('div', 'cell void'));
        continue;
      }
      const node = element('div', 'cell');
      if (cell.band) {
        node.classList.add('band');
        node.classList.toggle('band-first', cell.band.first);
        node.classList.toggle('band-last', cell.band.last);
      }
      if (cell.bits) {
        node.classList.add('bits');
        cell.bits.forEach((owner, bit) => {
          const at = byte * 8 + bit;
          const part = element('div', owner === null ? 'bit pad' : 'bit');
          if (owner !== null) {
            const leaf = layout.leaves[owner]!;
            part.style.background = `var(--${leaf.color})`;
            if (at === leaf.offsetBits) part.classList.add('start');
          }
          part.dataset.hover = '';
          part.dataset.byte = String(byte);
          part.dataset.leaves = owner === null ? '' : String(owner);
          node.append(part);
        });
      } else {
        node.dataset.hover = '';
        node.dataset.byte = String(byte);
        node.dataset.leaves = cell.leaves.join(' ');
        if (cell.leaves.length === 0) node.classList.add('pad');
        else if (cell.leaves.length === 1) {
          node.style.background = `var(--${layout.leaves[cell.leaves[0]!]!.color})`;
        } else {
          node.classList.add('multi');
          node.style.background = stripe(cell.leaves.map((index) => layout.leaves[index]!));
        }
        node.classList.toggle('start', cell.start);
      }
      grid.append(node);
    }
  }
  box.append(grid);
  return { element: box };
}

/** Up to three members' colours in diagonal stripes, for a byte they share. */
function stripe(leaves: LeafView[]): string {
  const colors = leaves.slice(0, 3).map((leaf) => `var(--${leaf.color})`);
  return `repeating-linear-gradient(45deg, ${colors.map((color, index) => `${color} ${index * 4}px, ${color} ${(index + 1) * 4}px`).join(', ')})`;
}

function fieldTable(record: RecordView, state: PanelState, actions: SectionActions): HTMLElement {
  const { layout } = record;
  const open = state.opened.get(record.name) ?? new Set<string>();
  const padAfter = paddingAfter(layout);
  const box = element('div', 'table-box');
  const table = element('table', 'field-table');
  const head = element('tr');
  head.append(element('th'), element('th', '', 'Field'), element('th', '', 'Type'));
  for (const [title, help] of [
    ['Offset', HEAD.offset],
    ['Size', HEAD.size],
    ['Align', HEAD.align],
    ['Padding after', HEAD.pad],
  ] as const) {
    const th = element('th');
    const label = element('span', 'help', title);
    label.title = help;
    th.append(label);
    head.append(th);
  }
  table.createTHead().append(head);
  const body = table.createTBody();

  const toggle = (id: string) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    state.opened.set(record.name, next);
    actions.rerender();
  };

  for (const { node, depth } of visibleRows(layout.tree, open)) {
    const tr = element('tr');
    tr.dataset.hover = '';
    const name = element('td', 'name');
    name.style.paddingLeft = `${8 + depth * INDENT}px`;
    name.style.setProperty('--depth', String(depth));
    const nest = element('div', 'nest');
    name.append(nest);
    const chip = element('td', 'chip-col');
    let range: Range | null;

    if (node.kind === 'leaf') {
      const leaf = layout.leaves[node.ref]!;
      range = leaf.nameRange;
      tr.dataset.leaves = String(node.ref);
      // A chip marks a member of this record; what is inside a named member has that member's.
      if (leaf.direct) chip.append(swatch(leaf.color));
      nest.append(element('span', 'twist-gap'), element('span', 'fname', leaf.name));
      const size = element('td', 'num', leafSize(leaf));
      if (leaf.sharesAddress) {
        size.classList.add('noted');
        size.title =
          'Its type is empty and it shares an address with another member, so it occupies no bytes, though sizeof(its type) is still 1.';
      }
      const pad = padAfter.get(node.ref);
      tr.append(
        chip,
        name,
        element('td', 'type', leaf.kind === 'special' ? '-' : (leaf.type ?? '')),
        element('td', 'num', formatOffset(leaf.offsetBits)),
        size,
        element('td', 'num', leaf.alignBits ? `${leaf.alignBits / 8} B` : ''),
        element('td', 'num pad', pad ? `+${pad} B` : ''),
      );
    } else {
      const group = layout.groups[node.ref]!;
      const id = nodeId(node);
      const shut = !open.has(id);
      range = group.nameRange;
      tr.className = 'group';
      tr.dataset.leaves = group.leafIndexes.join(' ');
      tr.dataset.group = String(node.ref);
      tr.dataset.shut = String(shut && node.children.length > 0);
      if (group.direct && group.color) chip.append(swatch(group.color));
      if (node.children.length > 0) {
        const twist = element('button', 'twist', shut ? '▸' : '▾');
        twist.type = 'button';
        twist.setAttribute('aria-expanded', String(!shut));
        twist.addEventListener('click', (event) => {
          event.stopPropagation();
          toggle(id);
        });
        nest.append(twist);
      } else {
        nest.append(element('span', 'twist-gap'));
      }
      if (group.recordId !== null) {
        const button = element('button', 'fname gname open', group.name);
        button.type = 'button';
        button.title = `Inspect ${group.type || group.name}`;
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          actions.inspect(group);
        });
        nest.append(button);
      } else {
        nest.append(element('span', 'fname gname', group.name));
      }
      if (group.isBase) nest.append(element('span', 'tag', 'base'));
      if (group.isUnion) nest.append(element('span', 'tag union', 'union'));
      if (node.overlaps) {
        const tag = element('span', 'tag overlap', 'overlaps');
        tag.title = 'shares bytes with a sibling';
        nest.append(tag);
      }
      const full = group.typeSizeBits;
      const short = group.sizeBits < full;
      const size = element('td', 'num', formatSizeShort(group.sizeBits) + (short ? ' *' : ''));
      if (short) {
        size.classList.add('noted');
        size.title =
          group.sizeBits === 0
            ? `Occupies no bytes here: it is empty, so it shares its address with the rest of the object, and sizeof(${group.type || group.name}) is ${full / 8} B only because a complete object cannot be zero-sized.`
            : `Occupies ${group.sizeBits / 8} B here, though sizeof(${group.type || group.name}) is ${full / 8} B, because the bytes after it are reused.`;
      }
      tr.addEventListener('dblclick', () => {
        actions.inspect(group);
      });
      tr.append(
        chip,
        name,
        element('td', 'type', group.type),
        element('td', 'num', formatOffset(group.offsetBits)),
        size,
        element('td', 'num', group.alignBits ? `${group.alignBits / 8} B` : ''),
        element('td', 'num'),
      );
    }
    // Here, unlike the web page, a row is also a way to its source.
    if (range) {
      const target = range;
      tr.classList.add('clickable');
      tr.tabIndex = 0;
      tr.addEventListener('click', () => {
        actions.reveal(target);
      });
      tr.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        actions.reveal(target);
      });
    }
    body.append(tr);
  }
  for (const marker of layout.markers) {
    if (marker.kind !== 'zero-bitfield') continue;
    const tr = element('tr', 'marker');
    const name = element('td', 'name');
    name.style.paddingLeft = `${8 + marker.path.length * INDENT}px`;
    name.style.setProperty('--depth', String(marker.path.length));
    const nest = element('div', 'nest');
    nest.append(
      element('span', 'twist-gap'),
      element('span', 'fname muted', `${marker.type} :0 (unit break)`),
    );
    name.append(nest);
    tr.append(
      element('td', 'chip-col'),
      name,
      element('td', 'type'),
      element('td', 'num', formatOffset(marker.offsetBits)),
      element('td', 'num', '0 b'),
      element('td', 'num'),
      element('td', 'num'),
    );
    body.append(tr);
  }
  box.append(table);
  return box;
}

function swatch(color: string): HTMLElement {
  const chip = element('span', 'chip');
  chip.style.background = `var(--${color})`;
  return chip;
}

/** The web's tooltip: name in bold, then type, offset and size; one block per member. */
function tooltipLines(
  record: RecordView,
  leaves: number[],
  group: GroupView | null,
  byte: number | null,
): { strong: string; lines: string[] }[] {
  if (group) {
    const occupies = `occupies ${group.sizeBits / 8} B`;
    const tags = [group.isBase ? 'base' : '', group.isUnion ? 'union' : '']
      .filter(Boolean)
      .join(' · ');
    return [
      {
        strong: [...group.path, group.name].join(' :: '),
        lines: [
          group.type,
          `offset ${formatOffset(group.offsetBits)} · ${group.typeSizeBits > group.sizeBits ? `${occupies} · sizeof ${group.typeSizeBits / 8} B` : occupies}`,
          tags,
        ].filter(Boolean),
      },
    ];
  }
  if (leaves.length === 0) {
    return [{ strong: 'padding', lines: byte === null ? ['unused bytes'] : [`byte ${byte}`] }];
  }
  return leaves.map((index) => {
    const leaf = record.layout.leaves[index]!;
    return {
      strong: leafName(leaf),
      lines: [
        leaf.type ?? '',
        `offset ${formatOffset(leaf.offsetBits)} · ${leafSize(leaf)}`,
        leaf.sharesAddress ? 'empty type sharing an address, occupies no bytes' : '',
        byte === null ? '' : `byte ${byte}`,
      ].filter(Boolean),
    };
  });
}

function showTip(
  tip: HTMLElement,
  target: HTMLElement,
  blocks: { strong: string; lines: string[] }[],
): void {
  tip.replaceChildren();
  blocks.forEach((block, index) => {
    if (index > 0) tip.append(element('br'), element('br'));
    tip.append(element('strong', '', block.strong));
    for (const line of block.lines) tip.append(element('br'), line);
  });
  tip.hidden = false;
  const box = target.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const x = Math.max(8, Math.min(box.left + box.width / 2 - width / 2, innerWidth - width - 8));
  let y = box.top - height - 8;
  if (y < 8) y = box.top + 30;
  tip.style.left = `${x + scrollX}px`;
  tip.style.top = `${y + scrollY}px`;
}

/** The bytes something occupies, as `[first, end)`. */
function extent(item: { offsetBits: number; sizeBits: number }): [number, number] {
  return [Math.floor(item.offsetBits / 8), Math.ceil((item.offsetBits + item.sizeBits) / 8)];
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
