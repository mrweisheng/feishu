import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2023',
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  // better-sqlite3 是原生模块,不打包进 bundle
  noExternal: [],
})
