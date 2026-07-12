import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const reactVersion = (require('react/package.json') as { version: string }).version;
const viteVersion = (require('vite/package.json') as { version: string }).version;
const tsVersion = (require('typescript/package.json') as { version: string }).version;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __REACT_VERSION__: JSON.stringify(reactVersion),
    __VITE_VERSION__: JSON.stringify(viteVersion),
    __TS_VERSION__: JSON.stringify(tsVersion),
  },
  build: { outDir: '../tether_ddns/static', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:8000' } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.ts',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/App.tsx',
        'src/**/*.test.{ts,tsx}',
      ],
      thresholds: {
        lines: 70,
        functions: 50,
        statements: 70,
        branches: 60,
      },
    },
  },
});
