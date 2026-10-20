import { describe, expect, it } from 'vitest';
import { Analyzer, type Analysis, type DocumentSnapshot } from '../../src/analysis.ts';
import { CompileCommandFinder } from '../../src/compile/compileCommandFinder.ts';
import type { ToolchainProber } from '../../src/compile/toolchain.ts';
import { createPathMap } from '../../src/engine/pathMap.ts';
import type { EngineRequest, EngineResponse } from '../../src/engine/engineTypes.ts';

function analyzer(
  probe: ToolchainProber['probe'] = () =>
    Promise.resolve({ triple: 'x86_64-linux-gnu', systemIncludes: [], msvcVersion: null }),
) {
  const queries: EngineRequest[] = [];
  const announced: Analysis[] = [];
  const engine = { failing: false };
  const instance = new Analyzer({
    engine: {
      query: async (request) => {
        queries.push(request);
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (engine.failing) {
          return { ok: false, error: 'out of memory' } as unknown as EngineResponse;
        }
        return {
          ok: true,
          records: [],
          diagnostics: [],
          clangVersion: '22',
        } as unknown as EngineResponse;
      },
    },
    commands: new CompileCommandFinder({ style: 'posix', compileCommandsDir: '/nonexistent' }),
    toolchains: { probe } as ToolchainProber,
    pathMap: createPathMap('linux'),
    settings: {
      style: 'posix',
      fallbackFlags: [],
      probePolicy: { projectFolders: [], allowedCompilers: [] },
      target: null,
      debounceMs: 50,
    },
    onAnalyzed: (analysis) => announced.push(analysis),
  });
  return { instance, queries, announced, engine };
}

const document = (version: number): DocumentSnapshot => ({
  uri: 'file:///p/a.cpp',
  version,
  getText: () => 'struct A {};',
});

describe('Analyzer', () => {
  it('analyses a version once, even when asked for it while it waits for quiet', async () => {
    const { instance, queries } = analyzer();
    instance.schedule(document(1));
    await instance.waitForAnalysis(document(1), 1_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(queries).toHaveLength(1);
  });

  it('keeps nothing for a document closed while it was analysed', async () => {
    const { instance, announced } = analyzer();
    const done = instance.analyze(document(1));
    instance.forget(document(1).uri);
    await done;
    expect(instance.kept(document(1).uri)).toBeUndefined();
    expect(announced).toHaveLength(0);
  });

  it('falls back to the bundled headers when the compiler cannot be run, and says so', async () => {
    const { instance } = analyzer(() => Promise.reject(new Error('spawn cc ENOENT')));
    const analysis = await instance.analyze(document(1));
    expect(analysis.kind).toBe('analyzed');
    if (analysis.kind === 'analyzed') {
      expect(analysis.document.context.warning).toMatch(
        /could not be asked for its headers \(spawn cc ENOENT\)/,
      );
    }
  });

  it('keeps the layouts that worked when a later version fails, and does not retry it', async () => {
    const { instance, queries, announced, engine } = analyzer();
    await instance.analyze(document(1));
    engine.failing = true;
    await instance.analyze(document(2));
    expect(instance.kept(document(1).uri)?.kind).toBe('analyzed');
    expect(instance.failure(document(2).uri, 2)).toBe('out of memory');
    expect(announced.map((analysis) => analysis.kind)).toEqual(['analyzed', 'failed']);

    // Answering from the kept analysis starts nothing new.
    const answer = await instance.waitForAnalysis(document(2), 1_000);
    expect(answer?.kind).toBe('analyzed');
    expect(queries).toHaveLength(2);
  });
});
