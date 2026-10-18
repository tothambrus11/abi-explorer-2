// What every drawing of a layout shares: the text map, the SVG in hovers, and
// the panel in VS Code and CLion all draw from these, so they agree on which
// byte is whose, which letter and colour a member gets, and how the member
// table reads.

import type { AnalysisContext, MemberView, RecordView } from '@abi-explorer/shared/protocol';
import { formatOffset, formatSizeShort } from './format.ts';

export type ByteOwner = number | null;

/** Every member touching each byte, in declaration order: several in a union, or bit-fields sharing a byte. */
export function byteMembers(record: RecordView): number[][] {
  const members: number[][] = Array.from({ length: Math.ceil(record.sizeBits / 8) }, () => []);
  record.members.forEach((member, index) => {
    if (member.sizeBits === 0) return;
    const first = Math.floor(member.offsetBits / 8);
    const last = Math.ceil((member.offsetBits + member.sizeBits) / 8) - 1;
    for (let byte = first; byte <= last && byte < members.length; byte++) {
      members[byte]!.push(index);
    }
  });
  return members;
}

/**
 * One cell per byte, holding the member it is drawn as, or null for padding.
 * Where members overlap (a union, bit-fields sharing a byte) that is the
 * `preferred` member when it is one of them, so a highlighted member shows
 * all of its bytes; otherwise the first. The table lists them all.
 */
export function byteOwners(record: RecordView, preferred: number | null = null): ByteOwner[] {
  return byteMembers(record).map((members) =>
    preferred !== null && members.includes(preferred) ? preferred : (members[0] ?? null),
  );
}

/** The letter a member is drawn with: a–z, then A–Z, then digits, then `#`. */
export function memberLetter(index: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return letters[index] ?? '#';
}

/** Bytes per row: 8 reads best in a hover; wide records get 16 so they stay short. */
export function bytesPerRow(sizeBytes: number): number {
  return sizeBytes > 128 ? 16 : 8;
}

/** Records past this size are listed but not mapped: hundreds of rows help nobody. */
export const MAX_MAPPED_BYTES = 512;

// Tableau's hues, each at the same mid luminance: white letters read on every
// colour, and every colour reads as text on light and dark themes alike, so
// images (which cannot follow the theme) and panels draw them the same.
const PALETTE = [
  '#527eae',
  '#be640c',
  '#4c8943',
  '#a56794',
  '#de4446',
  '#478682',
  '#96780f',
  '#9a745e',
];
/** Padding's hatching, and an image's muted text: as legible as the colours on either theme. */
export const PADDING_COLOR = '#7e7e7e';

/** The colour member `index` is drawn in; the hover image and the panel agree. */
export function memberColor(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}

export type LayoutRow =
  | { kind: 'member'; memberIndex: number; offsetBits: number; sizeBits: number }
  | { kind: 'padding'; offsetBits: number; sizeBits: number };

/** The member table: members and the padding runs between them, in offset order. */
export function layoutRows(record: RecordView): LayoutRow[] {
  const rows: LayoutRow[] = record.members.map((member, memberIndex) => ({
    kind: 'member',
    memberIndex,
    offsetBits: member.offsetBits,
    sizeBits: member.sizeBits,
  }));
  const owners = byteOwners(record);
  for (let byte = 0; byte < owners.length; byte++) {
    if (owners[byte] !== null) continue;
    const start = byte;
    while (byte + 1 < owners.length && owners[byte + 1] === null) byte++;
    rows.push({ kind: 'padding', offsetBits: start * 8, sizeBits: (byte - start + 1) * 8 });
  }
  // Stable, so a padding run sorts after a zero-sized member at the same offset.
  return rows.sort((a, b) => a.offsetBits - b.offsetBits);
}

/** The bytes to draw, or null when there are none or too many to be of use. */
export function mappedBytes(
  record: RecordView,
  preferred: number | null = null,
): ByteOwner[] | null {
  const owners = byteOwners(record, preferred);
  return owners.length === 0 || owners.length > MAX_MAPPED_BYTES ? null : owners;
}

/** `40 B · align 8 · 9 B padding`: the hover's and the panel's line for a record. */
export function recordSummary(record: RecordView): string {
  const parts = [formatSizeShort(record.sizeBits), `align ${record.alignBits / 8}`];
  if (record.paddingBytes) parts.push(`${record.paddingBytes} B padding`);
  return parts.join(' · ');
}

/**
 * The members (as indices) in the order that packs them tightest, and the
 * size that order would give; null when the order already costs nothing, or
 * the record is not a plain list of fields (bases, a vtable pointer,
 * bit-fields and unions are laid out by rules a reorder does not simply
 * change).
 */
export function tighterOrder(record: RecordView): { order: number[]; sizeBits: number } | null {
  if (record.kind === 'union' || record.paddingBytes === 0 || record.members.length < 2) {
    return null;
  }
  const fields = record.members
    .map((member, index) => ({ member, index }))
    .sort((a, b) => a.member.offsetBits - b.member.offsetBits);
  let end = 0;
  for (const { member } of fields) {
    // A flexible array member (size 0) has to stay last.
    const whole =
      member.offsetBits % 8 === 0 &&
      member.sizeBits % 8 === 0 &&
      member.sizeBits > 0 &&
      member.alignBits > 0;
    // Members sharing bytes are an anonymous union's.
    if (member.kind !== 'field' || !whole || member.offsetBits < end) return null;
    end = member.offsetBits + member.sizeBits;
  }
  // `#pragma pack` lowers the record's alignment, and each member's with it.
  const alignOf = (member: MemberView) => Math.min(member.alignBits, record.alignBits);
  const place = (order: readonly { member: MemberView }[]) => {
    let end = 0;
    const offsets = order.map(({ member }) => {
      const offset = roundUp(end, alignOf(member));
      end = offset + member.sizeBits;
      return offset;
    });
    return { offsets, size: roundUp(end, record.alignBits) };
  };
  // Only where these rules reproduce the layout as it is: an `alignas` on a
  // member, for one, is not in its alignment here.
  const current = place(fields);
  const reproduced =
    current.size === record.sizeBits &&
    current.offsets.every((offset, index) => offset === fields[index]!.member.offsetBits);
  if (!reproduced) return null;
  const order = [...fields].sort((a, b) => alignOf(b.member) - alignOf(a.member));
  const { size } = place(order);
  if (size >= record.sizeBits) return null;
  return { order: order.map(({ index }) => index), sizeBits: size };
}

/**
 * The server's warning on a record whose member order wastes space:
 * `Packet would take 32 B instead of 40 B with its members ordered as b, a, c.`,
 * or null (see `tighterOrder`).
 */
export function reorderWarning(record: RecordView): string | null {
  const tighter = tighterOrder(record);
  if (!tighter) return null;
  // The order itself while it is short enough to read in one line.
  const how =
    tighter.order.length <= 6
      ? `ordered as ${tighter.order.map((index) => record.members[index]!.label).join(', ')}`
      : 'ordered by alignment';
  return `${record.name} would take ${formatSizeShort(tighter.sizeBits)} instead of ${formatSizeShort(record.sizeBits)} with its members ${how}.`;
}

function roundUp(bits: number, alignBits: number): number {
  return Math.ceil(bits / alignBits) * alignBits;
}

/** `Shape at 0, Base at 8 (virtual)`, or null without bases. */
export function baseList(record: RecordView): string | null {
  if (record.bases.length === 0) return null;
  return record.bases
    .map(
      (base) =>
        `${base.name} at ${formatOffset(base.offsetBits)}${base.isVirtual ? ' (virtual)' : ''}`,
    )
    .join(', ');
}

/** Where the layouts come from, and anything that makes them less certain. */
export function contextNotes(context: AnalysisContext): string[] {
  const notes = [context.triple, context.commandSource];
  if (context.commandInferred) notes.push('flags borrowed from a neighbouring file');
  const errors = (count: number) => (count === 1 ? '1 error' : `${count} errors`);
  if (context.errorCount > 0) {
    notes.push(`${errors(context.errorCount)} in this file, so layouts may be incomplete`);
  }
  if (context.otherErrorCount > 0) {
    notes.push(`${errors(context.otherErrorCount)} in its headers or flags`);
  }
  if (context.firstError) notes.push(context.firstError);
  if (context.warning) notes.push(context.warning);
  return notes;
}
