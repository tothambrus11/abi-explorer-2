import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
export default config;
