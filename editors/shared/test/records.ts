// Records for tests, written as their members, with the rest worked out: the
// layout the engine would report for a plain list of fields (each member one
// leaf, coloured in order) and the sizes that equal `sizeof` when nothing
// differs.

import type { LayoutView, MemberView, RecordView } from '../src/protocol.ts';

export type TestMember = Omit<MemberView, 'leaves' | 'group'>;

export type TestRecord = Omit<
  RecordView,
  | 'members'
  | 'layout'
  | 'dataSizeBits'
  | 'nonVirtualSizeBits'
  | 'nonVirtualAlignBits'
  | 'preferredAlignBits'
> & { members: TestMember[] };

export function testRecord(record: TestRecord): RecordView {
  const members = record.members.map((member, index) => ({
    ...member,
    leaves: [index],
    group: null,
  }));
  const layout: LayoutView = {
    leaves: record.members.map((member, index) => ({
      kind:
        member.kind === 'bitfield' ? 'bitfield' : member.kind === 'special' ? 'special' : 'field',
      name: member.label,
      type: member.type,
      offsetBits: member.offsetBits,
      sizeBits: member.sizeBits,
      alignBits: member.alignBits,
      path: [],
      sharesAddress: false,
      direct: true,
      color: `c-${(index % 8) + 1}`,
      nameRange: member.nameRange,
    })),
    groups: [],
    tree: record.members.map((_, index) => ({
      kind: 'leaf',
      ref: index,
      overlaps: false,
      children: [],
    })),
    markers: [],
    paddings: paddingRuns(record.members, record.sizeBits),
  };
  return {
    ...record,
    dataSizeBits: record.sizeBits,
    nonVirtualSizeBits: record.sizeBits,
    nonVirtualAlignBits: record.alignBits,
    preferredAlignBits: record.alignBits,
    layout,
    members,
  };
}

/** Whole bytes no member touches, as runs. */
function paddingRuns(
  members: readonly TestMember[],
  sizeBits: number,
): { startBits: number; endBits: number }[] {
  const used = new Array<boolean>(Math.ceil(sizeBits / 8)).fill(false);
  for (const member of members) {
    for (let bit = member.offsetBits; bit < member.offsetBits + member.sizeBits; bit += 1) {
      used[Math.floor(bit / 8)] = true;
    }
  }
  const runs: { startBits: number; endBits: number }[] = [];
  used.forEach((isUsed, byte) => {
    if (isUsed) return;
    const last = runs.at(-1);
    if (last?.endBits === byte * 8) last.endBits += 8;
    else runs.push({ startBits: byte * 8, endBits: byte * 8 + 8 });
  });
  return runs;
}
