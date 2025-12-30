import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'retry/index': 'src/retry/index.ts',
    'circuit-breaker/index': 'src/circuit-breaker/index.ts',
    'errors/index': 'src/errors/index.ts',
    'core/index': 'src/core/index.ts',
    'utils/index': 'src/utils/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: 'es2020',
  outDir: 'dist',
  external: ['rxjs'],
  platform: 'neutral',
});
