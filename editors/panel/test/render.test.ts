// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutResult, RecordView } from '@abi-explorer/shared/protocol';
import { initialState, renderPanel, type PanelState } from '../src/render.ts';
import { testRecord, type TestMember } from '../../shared/test/records.ts';

const at = (line: number) => ({ start: { line, character: 2 }, end: { line, character: 6 } });

function member(label: string, offset: number, size: number, line: number): TestMember {
  return {
    kind: 'field',
    label,
    type: 'int',
    offsetBits: offset * 8,
    sizeBits: size * 8,
    alignBits: size * 8,
    nameRange: at(line),
  };
}

function record(
  id: number,
  name: string,
  members: TestMember[],
  sizeBytes: number,
  paddingBytes: number,
): RecordView {
  return testRecord({
    id,
    kind: 'struct',
    name,
    sizeBits: sizeBytes * 8,
    alignBits: 32,
    paddingBytes,
    nameRange: at(id * 10),
    extent: null,
    members,
    bases: [],
  });
}

const packet = record(1, 'Packet', [member('type', 0, 1, 11), member('length', 4, 4, 12)], 8, 3);
const header = record(2, 'Header', [member('id', 0, 4, 21)], 4, 0);

/** `struct Message { Header hdr; unsigned a : 3, b : 5; }`: a nested record and two bit-fields. */
const message: RecordView = (() => {
  const base = record(
    4,
    'Message',
    [
      member('id', 0, 4, 41),
      { ...member('a', 0, 0, 42), kind: 'bitfield', offsetBits: 32, sizeBits: 3, alignBits: 0 },
      { ...member('b', 0, 0, 43), kind: 'bitfield', offsetBits: 35, sizeBits: 5, alignBits: 0 },
    ],
    8,
    3,
  );
  const [id, a, b] = base.layout.leaves as [
    RecordView['layout']['leaves'][number],
    RecordView['layout']['leaves'][number],
    RecordView['layout']['leaves'][number],
  ];
  return {
    ...base,
    members: [
      { ...base.members[0]!, label: 'hdr', type: 'Header', leaves: [0], group: 0 },
      base.members[1]!,
      base.members[2]!,
    ],
    layout: {
      ...base.layout,
      leaves: [
        { ...id, path: ['hdr'], direct: false, color: 'c-1', nameRange: at(21) },
        { ...a, color: 'c-2' },
        { ...b, color: 'c-3' },
      ],
      groups: [
        {
          kind: 'member',
          name: 'hdr',
          type: 'Header',
          offsetBits: 0,
          sizeBits: 32,
          typeSizeBits: 32,
          alignBits: 32,
          path: [],
          isBase: false,
          isUnion: false,
          leafIndexes: [0],
          direct: true,
          color: 'c-1',
          nameRange: at(41),
          recordId: 2,
          declaration: null,
        },
      ],
      tree: [
        {
          kind: 'group',
          ref: 0,
          overlaps: false,
          children: [{ kind: 'leaf', ref: 0, overlaps: false, children: [] }],
        },
        { kind: 'leaf', ref: 1, overlaps: false, children: [] },
        { kind: 'leaf', ref: 2, overlaps: false, children: [] },
      ],
    },
  };
})();

function result(overrides: Partial<LayoutResult> = {}): LayoutResult {
  return {
    state: 'ready',
    message: null,
    records: [packet, header],
    selection: { recordId: 2, memberIndex: null },
    context: {
      triple: 'x86_64-linux-gnu',
      cxxAbi: 'itanium',
      clangVersion: '22',
      commandSource: 'CMake Tools',
      commandInferred: false,
      errorCount: 0,
      otherErrorCount: 0,
      firstError: null,
      warning: null,
    },
    ...overrides,
  };
}

let root: HTMLElement;
let state: PanelState;
const reveal = vi.fn();
const mark = vi.fn();
const copy = vi.fn();
const shown = vi.fn();
const actions = { reveal, mark, copy, shown };

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root')!;
  state = initialState();
  reveal.mockReset();
  mark.mockReset();
  copy.mockReset();
});

const texts = (selector: string) =>
  [...root.querySelectorAll(selector)].map((node) => node.textContent);

describe('renderPanel', () => {
  it('shows a tab per record, and the record at the caret as the web explorer does', () => {
    renderPanel(root, result(), state, actions);
    expect(texts('.chips button')).toEqual(['struct Packet 8 B', 'struct Header 4 B']);
    expect(texts('.chips button.selected')).toEqual(['struct Header 4 B']);
    expect(texts('.title')).toEqual(['struct Header']);
    expect(texts('.tile .label')).toEqual(['sizeof', 'alignof', 'padding']);
    expect(texts('.context')).toEqual(['x86_64-linux-gnu · CMake Tools']);
    // The editor dots the members of the record on screen only, as the web's does.
    expect(shown).toHaveBeenLastCalledWith([2]);
  });

  it('draws the web grid: a cell per byte, without letters, and the web table', () => {
    renderPanel(root, result({ selection: { recordId: 1, memberIndex: 1 } }), state, actions);
    expect(texts('.col')).toEqual(['+0', '+1', '+2', '+3', '+4', '+5', '+6', '+7']);
    expect(root.querySelectorAll('.cell')).toHaveLength(8);
    expect(root.querySelectorAll('.cell.pad')).toHaveLength(3);
    expect(texts('.cell').join('')).toBe('');
    expect(texts('.field-table th')).toEqual([
      '',
      'Field',
      'Type',
      'Offset',
      'Size',
      'Align',
      'Padding after',
    ]);
    expect(texts('.field-table tbody tr:first-child td')).toEqual([
      '',
      'type',
      'int',
      '0 B',
      '1 B',
      '1 B',
      '+3 B',
    ]);
    // The member at the caret is outlined, as a hovered one is on the web.
    expect(root.querySelectorAll('.cell.hovered')).toHaveLength(4);
    expect(root.querySelector('tr.hovered .fname')!.textContent).toBe('length');
  });

  it('draws a bit-field byte bit by bit', () => {
    renderPanel(root, result({ records: [message], selection: null }), state, actions);
    const bits = root.querySelectorAll('.cell.bits .bit');
    expect(bits).toHaveLength(8);
    expect([...bits].map((bit) => (bit as HTMLElement).style.background)).toEqual([
      ...Array.from({ length: 3 }, () => 'var(--c-2)'),
      ...Array.from({ length: 5 }, () => 'var(--c-3)'),
    ]);
  });

  it('stripes a byte that union members share', () => {
    const union = record(3, 'Value', [member('i', 0, 4, 31), member('d', 0, 8, 32)], 8, 0);
    renderPanel(
      root,
      result({ records: [union], selection: { recordId: 3, memberIndex: 1 } }),
      state,
      actions,
    );
    expect(root.querySelectorAll('.cell.multi')).toHaveLength(4);
    expect(root.querySelectorAll('.cell.hovered')).toHaveLength(8);
  });

  it('starts a compound member shut, and opens it with its twisty', () => {
    renderPanel(root, result({ records: [message], selection: null }), state, actions);
    expect(texts('.field-table tbody .fname')).toEqual(['hdr', 'a', 'b']);
    root.querySelector<HTMLButtonElement>('.twist')!.click();
    expect(texts('.field-table tbody .fname')).toEqual(['hdr', 'id', 'a', 'b']);
    // Still open after the next update.
    renderPanel(root, result({ records: [message], selection: null }), state, actions);
    expect(texts('.field-table tbody .fname')).toEqual(['hdr', 'id', 'a', 'b']);
  });

  it("opens a compound member's record from its name, as the web explorer does", () => {
    renderPanel(root, result({ records: [message, header], selection: null }), state, actions);
    root.querySelector<HTMLButtonElement>('button.open')!.click();
    expect(texts('.title')).toEqual(['struct Header']);
    expect(reveal).toHaveBeenCalledWith(at(20));
  });

  it('opens a record declared in another file at its declaration', () => {
    const elsewhere = {
      ...message,
      layout: {
        ...message.layout,
        groups: [
          {
            ...message.layout.groups[0]!,
            recordId: 9,
            declaration: { uri: 'file:///src/header.h', range: at(3) },
          },
        ],
      },
    };
    renderPanel(root, result({ records: [elsewhere], selection: null }), state, actions);
    root.querySelector<HTMLButtonElement>('button.open')!.click();
    expect(reveal).toHaveBeenCalledWith(at(3), 'file:///src/header.h');
  });

  it('lights a hovered member everywhere, and marks it in the document', () => {
    renderPanel(root, result({ selection: { recordId: 1, memberIndex: null } }), state, actions);
    const cell = root.querySelectorAll<HTMLElement>('.cell')[5]!;
    cell.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(root.querySelectorAll('.cell.hovered')).toHaveLength(4);
    expect(root.querySelector('tr.hovered .fname')!.textContent).toBe('length');
    expect(mark).toHaveBeenLastCalledWith([at(12)]);
    expect(root.querySelector('.tip')!.textContent).toBe('lengthintoffset 4 B · 4 Bbyte 5');
    root.querySelector('section')!.dispatchEvent(new Event('pointerleave'));
    expect(root.querySelectorAll('.cell.hovered')).toHaveLength(0);
    expect(mark).toHaveBeenLastCalledWith([]);
  });

  it('copies the record as text', () => {
    const withText = { ...packet, text: 'the drawing' };
    renderPanel(
      root,
      result({ records: [withText], selection: { recordId: 1, memberIndex: 0 } }),
      state,
      actions,
    );
    root.querySelector<HTMLButtonElement>('button.copy')!.click();
    expect(copy).toHaveBeenCalledWith('struct Packet · 8 B · align 4 · 3 B padding\n\nthe drawing');
  });

  it('offers no copy without text', () => {
    renderPanel(root, result(), state, actions);
    expect(root.querySelector('button.copy')).toBeNull();
  });

  it('reveals a member when its row is clicked, or entered from the keyboard', () => {
    renderPanel(root, result({ selection: { recordId: 1, memberIndex: null } }), state, actions);
    const row = root.querySelectorAll<HTMLElement>('.field-table tbody tr')[1]!;
    row.click();
    expect(reveal).toHaveBeenCalledWith(at(12));
    reveal.mockReset();
    expect(row.tabIndex).toBe(0);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(reveal).toHaveBeenCalledWith(at(12));
  });

  it('switches tabs on click and keeps the choice until the caret moves to another record', () => {
    renderPanel(root, result(), state, actions);
    root.querySelectorAll<HTMLElement>('.chips button')[0]!.click();
    expect(texts('.title')).toEqual(['struct Packet']);
    expect(reveal).toHaveBeenCalledWith(at(10));
    // The caret has not moved: the click still stands.
    renderPanel(root, result(), state, actions);
    expect(texts('.title')).toEqual(['struct Packet']);
    renderPanel(root, result({ selection: { recordId: 1, memberIndex: null } }), state, actions);
    renderPanel(root, result(), state, actions);
    expect(texts('.title')).toEqual(['struct Header']);
  });

  it('stacks every record, as the web view toggle does', () => {
    renderPanel(root, result(), state, actions);
    root.querySelector<HTMLButtonElement>('.icon-button')!.click();
    expect(texts('.title')).toEqual(['struct Packet', 'struct Header']);
    expect(root.querySelector<HTMLElement>('.chips')!.hidden).toBe(true);
  });

  it('says why there is nothing to show', () => {
    renderPanel(
      root,
      result({
        records: [],
        state: 'unavailable',
        message: 'No compile command found.',
        context: null,
      }),
      state,
      actions,
    );
    expect(texts('.empty')).toEqual(['No compile command found.']);
    renderPanel(root, result({ records: [], state: 'analyzing', context: null }), state, actions);
    expect(texts('.empty')).toEqual(['Analyzing…']);
  });
});
