import { describe, expect, it } from 'vitest';
import type { MemberView, RecordView } from '@abi-explorer/shared/protocol';
import { pinAction } from '../../src/layout/pinAction.ts';

const range = (line: number, start: number, endLine: number, end: number) => ({
  start: { line, character: start },
  end: { line: endLine, character: end },
});

const field = (label: string, offset: number, size: number): MemberView => ({
  kind: 'field',
  label,
  type: 'int',
  offsetBits: offset * 8,
  sizeBits: size * 8,
  alignBits: size * 8,
  nameRange: null,
});

/** `struct Packet { char type; int length; };`, indented, on lines 1–4. */
const lines = [
  'namespace net {',
  '  struct Packet {',
  '    char type;',
  '    int length;',
  '  };',
  '}',
  '',
];
const packet: RecordView = {
  id: 1,
  kind: 'struct',
  name: 'net::Packet',
  sizeBits: 64,
  alignBits: 32,
  paddingBytes: 3,
  nameRange: range(1, 9, 1, 15),
  extent: range(1, 2, 4, 3),
  members: [field('type', 0, 1), field('length', 4, 4)],
  bases: [],
};

describe('pinAction', () => {
  it('asserts the size and alignment after the definition, at its indentation', () => {
    const action = pinAction(packet, lines, 'c++')!;
    expect(action.title).toBe("Pin Packet's layout with static_assert (8 B, align 4)");
    expect(action.edit).toEqual({
      range: range(5, 0, 5, 0),
      newText:
        '  static_assert(sizeof(Packet) == 8, "Packet\'s size");\n' +
        '  static_assert(alignof(Packet) == 4, "Packet\'s alignment");\n',
    });
  });

  it('asserts each offset where the file has offsetof, and speaks C11 in C', () => {
    const action = pinAction(packet, ['#include <stddef.h>', ...lines.slice(1)], 'c')!;
    expect(action.edit.newText.split('\n')).toEqual([
      '  _Static_assert(sizeof(struct Packet) == 8, "Packet\'s size");',
      '  _Static_assert(_Alignof(struct Packet) == 4, "Packet\'s alignment");',
      '  _Static_assert(offsetof(struct Packet, type) == 0, "Packet::type\'s offset");',
      '  _Static_assert(offsetof(struct Packet, length) == 4, "Packet::length\'s offset");',
      '',
    ]);
  });

  it('adds its own line break at the end of a file without one', () => {
    const action = pinAction(packet, lines.slice(0, 5), 'c++')!;
    expect(action.edit.range).toEqual(range(4, 4, 4, 4));
    expect(action.edit.newText).toMatch(/^\n {2}static_assert\(sizeof.*\n.*alignment"\);$/);
  });

  it('is not offered for an instantiation or a definition that declares a variable', () => {
    expect(pinAction({ ...packet, name: 'Pair<int>' }, lines, 'c++')).toBeNull();
    const withVariable = [...lines.slice(0, 4), '  } packet;', '}'];
    expect(pinAction(packet, withVariable, 'c++')).toBeNull();
  });
});
