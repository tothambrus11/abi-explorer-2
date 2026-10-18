import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'server/test/**/*.test.ts',
      'panel/test/**/*.test.ts',
      'vscode/test/unit/**/*.test.ts',
    ],
    testTimeout: 60_000,
  },
});
