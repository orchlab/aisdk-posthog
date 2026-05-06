import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'aisdk-posthog',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
