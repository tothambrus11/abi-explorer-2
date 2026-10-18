// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutResult, MemberView, RecordView } from '@abi-explorer/shared/protocol';
import { renderPanel, type PanelState } from '../src/render.ts';

const at = (line: number) => ({ start: { line, character: 2 }, end: { line, character: 6 } });

function member(label: string, offset: number, size: number, line: number): MemberView {
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
  members: MemberView[],
  sizeBytes: number,
  paddingBytes: number,
): RecordView {
  return {
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
  };
}

const packet = record(1, 'Packet', [member('type', 0, 1, 11), member('length', 4, 4, 12)], 8, 3);
const header = record(2, 'Header', [member('id', 0, 4, 21)], 4, 0);

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
const copy = vi.fn();

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root')!;
  state = { choice: null };
  reveal.mockReset();
  copy.mockReset();
});

const texts = (selector: string) =>
  [...root.querySelectorAll(selector)].map((node) => node.textContent);

describe('renderPanel', () => {
  it('lists every record and opens the one at the caret', () => {
    renderPanel(root, result(), state, { reveal, copy });
    expect(texts('.record-name')).toEqual(['Packet', 'Header']);
    expect(texts('.record-size')).toEqual(['8 B · align 4 · 3 B padding', '4 B · align 4']);
    expect(texts('.record.open .record-name')).toEqual(['Header']);
    expect(texts('.context')).toEqual(['x86_64-linux-gnu · CMake Tools']);
  });

  it('draws one cell per byte and a table row per member and padding run', () => {
    renderPanel(root, result({ selection: { recordId: 1, memberIndex: 1 } }), state, {
      reveal,
      copy,
    });
    expect(root.querySelectorAll('.byte')).toHaveLength(8);
    expect(root.querySelectorAll('.byte.padding')).toHaveLength(3);
    expect(texts('.members tbody .member')).toEqual(['typeint', 'padding', 'lengthint']);
    // The member at the caret starts highlighted, the others dimmed.
    expect(root.querySelectorAll('.byte.highlighted')).toHaveLength(4);
    expect(root.querySelector('tr.highlighted .label')!.textContent).toBe('length');
  });

  it('draws a highlighted union member over every byte it shares', () => {
    const union = record(3, 'Value', [member('i', 0, 4, 31), member('d', 0, 8, 32)], 8, 0);
    const selected = (memberIndex: number) =>
      result({ records: [union], selection: { recordId: 3, memberIndex } });
    renderPanel(root, selected(1), state, { reveal, copy });
    expect(texts('.byte')).toEqual(Array.from({ length: 8 }, () => 'b'));
    expect(root.querySelectorAll('.byte.highlighted')).toHaveLength(8);
    renderPanel(root, selected(0), state, { reveal, copy });
    expect(texts('.byte')).toEqual(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b']);
    expect(root.querySelectorAll('.byte.highlighted')).toHaveLength(4);
  });

  it('copies the open record as text, without the caret mark', () => {
    const withText = { ...packet, text: '▶a  type  0  1 B  int' };
    renderPanel(
      root,
      result({ records: [withText], selection: { recordId: 1, memberIndex: 0 } }),
      state,
      { reveal, copy },
    );
    root.querySelector<HTMLButtonElement>('button.copy')!.click();
    expect(copy).toHaveBeenCalledWith(
      'struct Packet · 8 B · align 4 · 3 B padding\n\n a  type  0  1 B  int',
    );
  });

  it('offers no copy without text', () => {
    renderPanel(root, result(), state, { reveal, copy });
    expect(root.querySelector('button.copy')).toBeNull();
  });

  it('reveals a member when its row is clicked', () => {
    renderPanel(root, result({ selection: { recordId: 1, memberIndex: null } }), state, {
      reveal,
      copy,
    });
    root.querySelector<HTMLElement>('tr[data-member="1"]')!.click();
    expect(reveal).toHaveBeenCalledWith(at(12));
  });

  it('reveals a member from the keyboard, and lights up its bytes on focus', () => {
    renderPanel(root, result({ selection: { recordId: 1, memberIndex: null } }), state, {
      reveal,
      copy,
    });
    const row = root.querySelector<HTMLElement>('tr[data-member="1"]')!;
    expect(row.tabIndex).toBe(0);
    row.focus();
    expect(root.querySelectorAll('.byte.highlighted')).toHaveLength(4);
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(reveal).toHaveBeenCalledWith(at(12));
  });

  it('opens another record on click and keeps it open until the caret moves to one', () => {
    renderPanel(root, result(), state, { reveal, copy });
    (root.querySelectorAll('.record-heading')[0] as HTMLElement).click();
    expect(texts('.record.open .record-name')).toEqual(['Packet']);
    expect(reveal).toHaveBeenCalledWith(at(10));
    // The caret has not moved: the click still stands.
    renderPanel(root, result(), state, { reveal, copy });
    expect(texts('.record.open .record-name')).toEqual(['Packet']);
  });

  it('closes the open record on click, and keeps it closed while the caret stays put', () => {
    renderPanel(root, result(), state, { reveal, copy });
    (root.querySelectorAll('.record-heading')[1] as HTMLElement).click();
    expect(root.querySelectorAll('.record.open')).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();
    renderPanel(root, result(), state, { reveal, copy });
    expect(root.querySelectorAll('.record.open')).toHaveLength(0);
    renderPanel(root, result({ selection: { recordId: 1, memberIndex: null } }), state, {
      reveal,
      copy,
    });
    expect(texts('.record.open .record-name')).toEqual(['Packet']);
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
      { reveal, copy },
    );
    expect(texts('.empty')).toEqual(['No compile command found.']);
    renderPanel(root, result({ records: [], state: 'analyzing', context: null }), state, {
      reveal,
      copy,
    });
    expect(texts('.empty')).toEqual(['Analyzing…']);
  });
});
