import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', ai: 'src/ai.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  target: 'node22',
  outDir: 'dist',
});
