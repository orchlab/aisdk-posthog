import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'aisdk-posthog',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
