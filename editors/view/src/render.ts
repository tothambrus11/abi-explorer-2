// The layout panel: every record in the file, the one at the caret opened up
// with its byte map and member table.
//
// Plain DOM, no framework: the whole panel is one function from a layout
// result to elements, re-run on every update, and a few listeners that
// highlight a member's bytes and row together.

import type { LayoutResult, Range, RecordView } from 'abi-explorer-lsp/protocol';
import { formatOffset, formatSizeShort } from 'abi-explorer-lsp/format';
import {
  byteOwners,
  bytesPerRow,
  layoutRows,
  MAX_MAPPED_BYTES,
  memberColor,
  memberLetter,
} from 'abi-explorer-lsp/layoutModel';

export interface PanelActions {
  reveal(range: Range): void;
}

export interface PanelState {
  /** The record the user opened by clicking; the caret's record wins when it moves. */
  openRecordId: number | null;
}

export function renderPanel(root: HTMLElement, result: LayoutResult, state: PanelState, actions: PanelActions): void {
  const openId = result.selection?.recordId ?? state.openRecordId ?? result.records[0]?.id ?? null;
  state.openRecordId = openId;
  root.replaceChildren();

  if (result.records.length === 0) {
    root.append(
      element('p', 'empty', result.state === 'analyzing' ? 'Analyzing…' : (result.message ?? 'No layouts yet.')),
    );
    return;
  }
  if (result.message) root.append(element('p', 'notice', result.message));

  const list = element('ul', 'records');
  for (const record of result.records) {
    const isOpen = record.id === openId;
    const item = element('li', isOpen ? 'record open' : 'record');
    const heading = element('button', 'record-heading');
    heading.type = 'button';
    heading.setAttribute('aria-expanded', String(isOpen));
    heading.append(
      element('span', 'chevron', isOpen ? '▾' : '▸'),
      element('span', 'record-name', record.name),
      element('span', 'record-size', recordSummary(record)),
    );
    heading.addEventListener('click', () => {
      state.openRecordId = isOpen ? null : record.id;
      if (record.nameRange) actions.reveal(record.nameRange);
      renderPanel(root, { ...result, selection: null }, state, actions);
    });
    item.append(heading);
    if (isOpen) {
      const memberIndex = result.selection?.recordId === record.id ? result.selection.memberIndex : null;
      item.append(recordDetails(record, memberIndex, actions));
    }
    list.append(item);
  }
  root.append(list);

  if (result.context) {
    const notes = [result.context.triple, result.context.commandSource];
    if (result.context.commandInferred) notes.push('flags borrowed from a neighbouring file');
    if (result.context.errorCount > 0) notes.push(`${result.context.errorCount} errors, layouts may be incomplete`);
    if (result.state === 'analyzing') notes.push('updating…');
    root.append(element('p', 'context', notes.join(' · ')));
  }
}

function recordSummary(record: RecordView): string {
  const parts = [formatSizeShort(record.sizeBits), `align ${record.alignBits / 8}`];
  if (record.paddingBytes) parts.push(`${record.paddingBytes} B padding`);
  return parts.join(' · ');
}

function recordDetails(record: RecordView, highlighted: number | null, actions: PanelActions): HTMLElement {
  const details = element('div', 'record-details');
  if (record.bases.length > 0) {
    const bases = record.bases.map((base) => `${base.name} at ${formatOffset(base.offsetBits)}${base.isVirtual ? ' (virtual)' : ''}`);
    details.append(element('p', 'summary', `Bases: ${bases.join(', ')}`));
  }
  const map = byteMap(record, actions);
  if (map) details.append(map);
  details.append(memberTable(record, actions));
  const highlight = (index: number | null) => {
    for (const node of details.querySelectorAll<HTMLElement>('[data-member]')) {
      node.classList.toggle('highlighted', index !== null && node.dataset['member'] === String(index));
      node.classList.toggle('dimmed', index !== null && node.dataset['member'] !== String(index));
    }
  };
  details.addEventListener('pointerover', (event) => {
    const owner = (event.target as HTMLElement).closest<HTMLElement>('[data-member]');
    highlight(owner ? Number(owner.dataset['member']) : highlighted);
  });
  details.addEventListener('pointerleave', () => highlight(highlighted));
  highlight(highlighted);
  return details;
}

function byteMap(record: RecordView, actions: PanelActions): HTMLElement | null {
  const owners = byteOwners(record);
  if (owners.length === 0 || owners.length > MAX_MAPPED_BYTES) return null;
  const perRow = bytesPerRow(owners.length);
  const grid = element('div', 'byte-map');
  grid.style.setProperty('--columns', String(perRow));
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', `${record.name}: ${owners.length} bytes`);
  grid.append(element('span', 'corner'));
  for (let column = 0; column < perRow; column++) grid.append(element('span', 'column-label', String(column)));
  owners.forEach((owner, byte) => {
    if (byte % perRow === 0) grid.append(element('span', 'row-label', String(byte)));
    if (owner === null) {
      grid.append(element('span', 'byte padding'));
      return;
    }
    const cell = element('span', 'byte', memberLetter(owner));
    cell.dataset['member'] = String(owner);
    cell.style.setProperty('--member-color', memberColor(owner));
    cell.title = `${record.members[owner]!.label} · byte ${byte}`;
    cell.addEventListener('click', () => revealMember(record, owner, actions));
    grid.append(cell);
  });
  return grid;
}

function memberTable(record: RecordView, actions: PanelActions): HTMLElement {
  const table = element('table', 'members');
  const head = element('tr');
  for (const [title, className] of [['', ''], ['Member', ''], ['Offset', 'number'], ['Size', 'number']] as const) {
    head.append(element('th', className, title));
  }
  table.createTHead().append(head);
  const body = table.createTBody();
  for (const row of layoutRows(record)) {
    const tr = element('tr');
    if (row.kind === 'padding') {
      tr.className = 'padding';
      tr.append(
        element('td', 'swatch', '·'),
        element('td', 'member', 'padding'),
        element('td', 'number', formatOffset(row.offsetBits)),
        element('td', 'number', formatSizeShort(row.sizeBits)),
      );
    } else {
      const member = record.members[row.memberIndex]!;
      tr.dataset['member'] = String(row.memberIndex);
      tr.style.setProperty('--member-color', memberColor(row.memberIndex));
      // Name and type on one line; a long type is cut short, its tooltip whole.
      const name = element('td', 'member');
      name.append(element('span', 'label', member.label));
      if (member.type && member.type !== member.label) name.append(element('span', 'type', member.type));
      name.title = member.type ? `${member.label}: ${member.type}` : member.label;
      tr.append(
        element('td', 'swatch', memberLetter(row.memberIndex)),
        name,
        element('td', 'number', formatOffset(member.offsetBits)),
        element('td', 'number', formatSizeShort(member.sizeBits)),
      );
      if (member.nameRange) {
        tr.classList.add('clickable');
        tr.addEventListener('click', () => revealMember(record, row.memberIndex, actions));
      }
    }
    body.append(tr);
  }
  return table;
}

function revealMember(record: RecordView, memberIndex: number, actions: PanelActions): void {
  const range = record.members[memberIndex]?.nameRange;
  if (range) actions.reveal(range);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
