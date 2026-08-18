import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FixtureCompiler, type CompileJob, type CompileOutput } from '$compiler/Compiler';
import type { Fixture } from './fixtures.capture.test';

const DIR = path.join(process.cwd(), 'tests', 'fixtures');

export function loadFixture(name: string, triple: string): Fixture {
  return JSON.parse(readFileSync(path.join(DIR, `${name}--${triple}.json`), 'utf8')) as Fixture;
}

/** A compiler that replays a fixture's recorded outputs by exact job match. */
export function fixtureCompiler(fx: Fixture): FixtureCompiler {
  const key = (j: CompileJob) => JSON.stringify([j.argv0, j.args, j.files]);
  const map = new Map(fx.calls.map((c) => [key(c.job), c.out]));
  return new FixtureCompiler((job): CompileOutput => {
    const out = map.get(key(job));
    if (!out)
      {throw new Error(
        `no recorded output for job:\n${JSON.stringify(job.args)}\nfiles: ${Object.keys(job.files).join(',')}`,
      );}
    return out;
  });
}

export function optionsFor(fx: Fixture) {
  return { lang: fx.lang, std: fx.lang === 'c++' ? 'gnu++20' : 'gnu17', triple: fx.triple };
}
