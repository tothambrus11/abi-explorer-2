// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LayoutResult, MemberView, RecordView } from 'abi-explorer-lsp/protocol';
import { renderPanel, type PanelState } from '../src/render.ts';

const at = (line: number) => ({ start: { line, character: 2 }, end: { line, character: 6 } });

function member(label: string, offset: number, size: number, line: number): MemberView {
  return { kind: 'field', label, type: 'int', offsetBits: offset * 8, sizeBits: size * 8, alignBits: size * 8, nameRange: at(line) };
}

function record(id: number, name: string, members: MemberView[], sizeBytes: number, paddingBytes: number): RecordView {
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
    paddingRuns: [],
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
    context: { triple: 'x86_64-linux-gnu', cxxAbi: 'itanium', clangVersion: '22', commandSource: 'CMake Tools', commandInferred: false, errorCount: 0 },
    ...overrides,
  };
}

let root: HTMLElement;
let state: PanelState;
const reveal = vi.fn();

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root')!;
  state = { openRecordId: null };
  reveal.mockReset();
});

const texts = (selector: string) => [...root.querySelectorAll(selector)].map((node) => node.textContent);

describe('renderPanel', () => {
  it('lists every record and opens the one at the caret', () => {
    renderPanel(root, result(), state, { reveal });
    expect(texts('.record-name')).toEqual(['Packet', 'Header']);
    expect(texts('.record-size')).toEqual(['8 B · align 4 · 3 B padding', '4 B · align 4']);
    expect(texts('.record.open .record-name')).toEqual(['Header']);
    expect(texts('.context')).toEqual(['x86_64-linux-gnu · CMake Tools']);
  });

  it('draws one cell per byte and a table row per member and padding run', () => {
    renderPanel(root, result({ selection: { recordId: 1, memberIndex: 1 } }), state, { reveal });
    expect(root.querySelectorAll('.byte')).toHaveLength(8);
    expect(root.querySelectorAll('.byte.padding')).toHaveLength(3);
    expect(texts('.members tbody .member')).toEqual(['typeint', 'padding', 'lengthint']);
    // The member at the caret starts highlighted, the others dimmed.
    expect(root.querySelectorAll('.byte.highlighted')).toHaveLength(4);
    expect(root.querySelector('tr.highlighted .label')!.textContent).toBe('length');
  });

  it('reveals a member when its row is clicked', () => {
    renderPanel(root, result({ selection: { recordId: 1, memberIndex: null } }), state, { reveal });
    (root.querySelector('tr[data-member="1"]') as HTMLElement).click();
    expect(reveal).toHaveBeenCalledWith(at(12));
  });

  it('opens another record on click and keeps it open until the caret moves to one', () => {
    renderPanel(root, result(), state, { reveal });
    (root.querySelectorAll('.record-heading')[0] as HTMLElement).click();
    expect(texts('.record.open .record-name')).toEqual(['Packet']);
    expect(reveal).toHaveBeenCalledWith(at(10));
    renderPanel(root, result({ selection: null }), state, { reveal });
    expect(texts('.record.open .record-name')).toEqual(['Packet']);
  });

  it('says why there is nothing to show', () => {
    renderPanel(root, result({ records: [], state: 'unavailable', message: 'No compile command found.', context: null }), state, { reveal });
    expect(texts('.empty')).toEqual(['No compile command found.']);
    renderPanel(root, result({ records: [], state: 'analyzing', context: null }), state, { reveal });
    expect(texts('.empty')).toEqual(['Analyzing…']);
  });
});
