// Does the wire this app declares still match the wire the module emits?
//
// `$core/render` names the fields the app reads. The module publishes the same
// contract in its own `index.d.ts`, and nothing links the two: rename a field
// upstream and this app keeps compiling against its stale copy, then reads
// `undefined` at runtime. That happened while `paddingBits` became
// `paddingBytes`, and only a full run of the app caught it.
//
// So: read the interface declarations out of the source, and check every field
// against a response the module actually produced. No hand-written list of
// names to keep in step — the declarations *are* the list.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { corpus } from './corpus';
import type { WireResponse } from '$core/render';

/** Property names declared on `export interface <name>`, in source order. */
function declaredFields(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  expect(start, `interface ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let i = source.indexOf('{', start);
  const open = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) break;
  }
  const body = source
    .slice(open + 1, i)
    // Comments can contain anything that looks like a declaration.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  // Only properties at the top level of the block; a nested object type's own
  // fields are checked through their own interface or not at all.
  const fields: string[] = [];
  let nest = 0;
  for (const line of body.split('\n')) {
    const before = nest;
    nest += (line.match(/[{[]/g)?.length ?? 0) - (line.match(/[}\]]/g)?.length ?? 0);
    if (before !== 0) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)(\??):/.exec(line);
    if (m && m[2] !== '?') fields.push(m[1]!);
  }
  return fields;
}

const SOURCE = readFileSync(path.join(process.cwd(), 'src', 'core', 'render.ts'), 'utf8');

describe('the wire the app declares', () => {
  // Read the recorded responses directly: `corpus()` hands back projected
  // analyses, and what this test is about is the shape *before* the projection.
  const RAW: WireResponse[] = corpus().map((e) => {
    const file = path.join(process.cwd(), 'tests', 'fixtures', 'responses', `${e.name}.json`);
    return (JSON.parse(readFileSync(file, 'utf8')) as { response: WireResponse }).response;
  });

  it('has responses to check against', () => {
    expect(RAW.length).toBeGreaterThan(10);
  });

  /** Every declared field of `iface` is present on some real `pick(response)`. */
  const check = (iface: string, pick: (r: WireResponse) => unknown[]) => {
    it(`${iface}: every field it names is emitted`, () => {
      const fields = declaredFields(SOURCE, iface);
      expect(fields.length, `${iface} declares fields`).toBeGreaterThan(0);
      const found = RAW.flatMap(pick).filter(
        (x): x is object => x !== null && typeof x === 'object',
      );
      expect(found.length, `${iface}: the corpus has an example`).toBeGreaterThan(0);
      const sample = found[0]!;
      const missing = fields.filter((f) => !(f in sample));
      expect(missing, `${iface}: not on the wire`).toEqual([]);
    });
  };

  check('WireResponse', (r) => [r]);
  check('WireHeaders', (r) => [r.headers]);
  check('WireRecord', (r) => r.records);
  check('WireField', (r) => r.records.flatMap((x) => x.fields));
  check('WireRender', (r) => r.records.map((x) => x.render));
  check('WireLeaf', (r) => r.records.flatMap((x) => x.render.leaves));
  check('WireGroup', (r) => r.records.flatMap((x) => x.render.groups));
  check('WireMarker', (r) => r.records.flatMap((x) => x.render.markers));
  check('WireNode', (r) => r.records.flatMap((x) => x.render.tree));
  check('WireTypedef', (r) => r.typedefs);
  check('WireDiagnostic', (r) => r.diagnostics);
  check('WireLocation', (r) => r.records.map((x) => x.location));
  check('WireRange', (r) => r.records.map((x) => x.range));
});
