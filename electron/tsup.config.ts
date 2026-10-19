import { defineConfig } from 'tsup';

export default defineConfig((options) => [
  {
    entry: ['src/preload/index.ts', 'src/preload/titlebar.ts'],
    outDir: 'dist/preload',
    format: ['cjs'],
    target: 'node22',
    external: ['electron'],
    clean: false,
    sourcemap: true,
  },
  {
    entry: ['src/main/index.ts'],
    outDir: 'dist/main',
    format: ['esm'],
    target: 'node22',
    external: ['electron', '@xhayper/discord-rpc'],
    clean: true,
    sourcemap: true,
    onSuccess: options.watch ? 'electron .' : undefined,
  },
]);

