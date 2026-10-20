import { describe, expect, it } from 'vitest';
import { ENGINE_RELEASE } from '../../src/engine/engineFiles.ts';

describe('the pinned engine release', () => {
  // clang-abi-wasm names each release asset after its content, so an asset that
  // does not carry its file's hash is a pin that downloads the wrong thing, or nothing.
  it('downloads each file from the asset named after its hash', () => {
    for (const file of ENGINE_RELEASE.files) {
      expect(file.asset).toContain(`-${file.sha256.slice(0, 12)}.`);
      expect(file.asset.split('.').at(-1)).toBe(file.name.split('.').at(-1));
    }
  });

  it('downloads from the release its tag names', () => {
    expect(ENGINE_RELEASE.baseUrl).toBe(
      `https://github.com/tothambrus11/clang-abi-wasm/releases/download/${ENGINE_RELEASE.tag}/`,
    );
  });
});
