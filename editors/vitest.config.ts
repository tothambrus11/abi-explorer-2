import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'server/test/**/*.test.ts',
      'panel/test/**/*.test.ts',
      'vscode/test/unit/**/*.test.ts',
      'neovim/test/**/*.test.ts',
    ],
    // Real build systems, slow: `npm run test:build-systems`.
    exclude: [...configDefaults.exclude, 'server/test/build-systems/**'],
    testTimeout: 60_000,
  },
});
