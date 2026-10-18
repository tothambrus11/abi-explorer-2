// The layout panel: every record in the file, the one at the caret opened up
// with its byte map and member table.
//
// Plain DOM, no framework: the whole panel is one function from a layout
// result to elements, re-run on every update, and a few listeners that
// highlight a member's bytes and row together.

import type { LayoutResult, Range, RecordView } from '@abi-explorer/shared/protocol';
import { formatOffset, formatSizeShort } from '@abi-explorer/shared/format';
import {
  baseList,
  byteMembers,
  bytesPerRow,
  contextNotes,
  layoutRows,
  mappedBytes,
  memberColor,
  memberLetter,
  recordSummary,
  reorderNote,
} from '@abi-explorer/shared/layoutModel';

export interface PanelActions {
  reveal(range: Range): void;
  /** Puts text on the clipboard; the host does it, a webview may not. */
  copy(text: string): void;
}

export interface PanelState {
  /**
   * What the user opened (or, with null, closed) by clicking. It holds while
   * the caret stays in the record it was in then; moving to another hands the
   * choice back to the caret.
   */
  choice: { openRecordId: number | null; caretRecordId: number | null } | null;
}

export function renderPanel(
  root: HTMLElement,
  result: LayoutResult,
  state: PanelState,
  actions: PanelActions,
): void {
  const caretRecordId = result.selection?.recordId ?? null;
  if (state.choice && state.choice.caretRecordId !== caretRecordId) state.choice = null;
  const openId = state.choice
    ? state.choice.openRecordId
    : (caretRecordId ?? result.records[0]?.id ?? null);
  root.replaceChildren();

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
      state.choice = { openRecordId: isOpen ? null : record.id, caretRecordId };
      // Opening a record also takes the caret there; closing one leaves the caret alone.
      if (!isOpen && record.nameRange) actions.reveal(record.nameRange);
      renderPanel(root, result, state, actions);
    });
    item.append(heading);
    if (isOpen) {
      const memberIndex =
        result.selection?.recordId === record.id ? result.selection.memberIndex : null;
      item.append(recordDetails(record, memberIndex, actions));
    }
    list.append(item);
  }
  root.append(list);

  if (result.context) {
    const notes = contextNotes(result.context);
    if (result.state === 'analyzing') notes.push('updating…');
    root.append(element('p', 'context', notes.join(' · ')));
  }
}

function recordDetails(
  record: RecordView,
  highlighted: number | null,
  actions: PanelActions,
): HTMLElement {
  const details = element('div', 'record-details');
  const bases = baseList(record);
  if (bases) details.append(element('p', 'summary', `Bases: ${bases}`));
  const reorder = reorderNote(record);
  if (reorder) details.append(element('p', 'summary', reorder));
  const map = byteMap(record, actions);
  if (map) details.append(map);
  details.append(memberTable(record, actions));
  // The layout as text, to paste into a review or an issue; the server draws it (`includeText`).
  if (record.text) {
    const copy = element('button', 'copy', 'Copy as text');
    copy.type = 'button';
    copy.title = 'Copy the byte map and member table as text';
    // Without the caret's `▶`: that only means something here.
    const layout = record.text.replaceAll('▶', ' ');
    const text = `${record.kind} ${record.name} · ${recordSummary(record)}\n\n${layout}`;
    copy.addEventListener('click', () => {
      actions.copy(text);
    });
    details.append(copy);
  }
  const highlight = (index: number | null) => {
    for (const row of details.querySelectorAll<HTMLElement>('tr[data-member]')) {
      row.classList.toggle('highlighted', index !== null && row.dataset.member === String(index));
      row.classList.toggle('dimmed', index !== null && row.dataset.member !== String(index));
    }
    for (const cell of details.querySelectorAll<HTMLElement>('.byte[data-member]')) {
      // A byte several members share (a union) is drawn as the highlighted one when it is among them.
      const covers = index !== null && cell.dataset.covers!.split(' ').includes(String(index));
      drawCell(cell, covers ? index : Number(cell.dataset.member));
      cell.classList.toggle('highlighted', covers);
      cell.classList.toggle('dimmed', index !== null && !covers);
    }
  };
  details.addEventListener('pointerover', (event) => {
    const owner = (event.target as HTMLElement).closest<HTMLElement>('[data-member]');
    highlight(owner ? Number(owner.dataset.member) : highlighted);
  });
  details.addEventListener('pointerleave', () => {
    highlight(highlighted);
  });
  highlight(highlighted);
  return details;
}

function byteMap(record: RecordView, actions: PanelActions): HTMLElement | null {
  const owners = mappedBytes(record);
  if (!owners) return null;
  const perRow = bytesPerRow(owners.length);
  const grid = element('div', 'byte-map');
  grid.style.setProperty('--columns', String(perRow));
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', `${record.name}: ${owners.length} bytes`);
  grid.append(element('span', 'corner'));
  for (let column = 0; column < perRow; column++) {
    grid.append(element('span', 'column-label', String(column)));
  }
  const members = byteMembers(record);
  owners.forEach((owner, byte) => {
    if (byte % perRow === 0) grid.append(element('span', 'row-label', String(byte)));
    if (owner === null) {
      grid.append(element('span', 'byte padding'));
      return;
    }
    const cell = element('span', 'byte');
    cell.dataset.member = String(owner);
    cell.dataset.covers = members[byte]!.join(' ');
    drawCell(cell, owner);
    const names = members[byte]!.map((index) => record.members[index]!.label).join(', ');
    cell.title = `${names} · byte ${byte}`;
    cell.addEventListener('click', () => {
      revealMember(record, owner, actions);
    });
    grid.append(cell);
  });
  return grid;
}

function drawCell(cell: HTMLElement, memberIndex: number): void {
  cell.textContent = memberLetter(memberIndex);
  cell.style.setProperty('--member-color', memberColor(memberIndex));
}

function memberTable(record: RecordView, actions: PanelActions): HTMLElement {
  const table = element('table', 'members');
  const head = element('tr');
  for (const [title, className] of [
    ['', ''],
    ['Member', ''],
    ['Offset', 'number'],
    ['Size', 'number'],
  ] as const) {
    head.append(element('th', className, title));
  }
  table.createTHead().append(head);
  const body = table.createTBody();
  for (const row of layoutRows(record)) {
    const tr = element('tr');
    if (row.kind === 'padding') {
      tr.className = 'padding';
      tr.append(
        element('td', 'swatch'),
        element('td', 'member', 'padding'),
        element('td', 'number', formatOffset(row.offsetBits)),
        element('td', 'number', formatSizeShort(row.sizeBits)),
      );
    } else {
      const member = record.members[row.memberIndex]!;
      tr.dataset.member = String(row.memberIndex);
      tr.style.setProperty('--member-color', memberColor(row.memberIndex));
      // Name and type on one line; a long type is cut short, its tooltip whole.
      const name = element('td', 'member');
      name.append(element('span', 'label', member.label));
      if (member.type && member.type !== member.label) {
        name.append(element('span', 'type', member.type));
      }
      name.title = member.type ? `${member.label}: ${member.type}` : member.label;
      tr.append(
        element('td', 'swatch', memberLetter(row.memberIndex)),
        name,
        element('td', 'number', formatOffset(member.offsetBits)),
        element('td', 'number', formatSizeShort(member.sizeBits)),
      );
      if (member.nameRange) {
        tr.classList.add('clickable');
        tr.addEventListener('click', () => {
          revealMember(record, row.memberIndex, actions);
        });
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
