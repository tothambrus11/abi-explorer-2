import { describe, expect, it } from 'vitest';
import type { RecordView } from '@abi-explorer/shared/protocol';
import { testRecord, type TestMember } from '../../../shared/test/records.ts';
import { pinAction } from '../../src/layout/pinAction.ts';

const range = (line: number, start: number, endLine: number, end: number) => ({
  start: { line, character: start },
  end: { line: endLine, character: end },
});

const field = (label: string, offset: number, size: number): TestMember => ({
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
const packet: RecordView = testRecord({
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
});

describe('pinAction', () => {
  it('asserts the size and alignment after the definition, at its indentation', () => {
    const action = pinAction(packet, lines, 'c++')!;
    expect(action.title).toBe('Pin layout with static_assert');
    expect(action.edit).toEqual({
      range: range(5, 0, 5, 0),
      newText:
        '  static_assert(sizeof(net::Packet) == 8, "Packet\'s size");\n' +
        '  static_assert(alignof(net::Packet) == 4, "Packet\'s alignment");\n',
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

  it("leaves out offsets it could not name from outside: a class's private members", () => {
    const withPrivate = [
      '#include <cstddef>',
      '  struct Packet {',
      '  private:',
      '    char type;',
      '  };',
      '',
    ];
    const shifted = { ...packet, nameRange: range(1, 9, 1, 15), extent: range(1, 2, 4, 3) };
    expect(pinAction(shifted, withPrivate, 'c++')!.edit.newText).not.toContain('offsetof');
    expect(
      pinAction({ ...shifted, kind: 'class' }, ['#include <cstddef>', ...lines.slice(1)], 'c++')!
        .edit.newText,
    ).not.toContain('offsetof');
    expect(
      pinAction(shifted, ['#include <cstddef>', ...lines.slice(1)], 'c++')!.edit.newText,
    ).toContain('offsetof');
  });

  it('is offered after a definition that declares a variable too, but not for an instantiation', () => {
    expect(pinAction({ ...packet, name: 'Pair<int>' }, lines, 'c++')).toBeNull();
    const withVariable = [...lines.slice(0, 4), '  } packet;', '}'];
    expect(pinAction(packet, withVariable, 'c++')?.edit.range.start.line).toBe(5);
    const continued = [...lines.slice(0, 4), '  } packet = {', '  };'];
    expect(pinAction(packet, continued, 'c++')).toBeNull();
  });

  it('names a typedef of an anonymous struct by the typedef, in C too', () => {
    const typedef = ['typedef struct {', '  char type;', '  int length;', '} Packet;', ''];
    const anonymous = {
      ...packet,
      name: 'Packet',
      nameRange: range(3, 2, 3, 8),
      extent: range(0, 8, 3, 8),
    };
    expect(pinAction(anonymous, typedef, 'c')!.edit.newText).toContain('sizeof(Packet) == 8');
  });
});
