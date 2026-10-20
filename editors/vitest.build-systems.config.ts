import { defineConfig } from 'vitest/config';

// Real CMake, Meson, Bazel and Conan projects: `npm run test:build-systems`.
export default defineConfig({
  test: {
    include: ['server/test/build-systems/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
  },
});
