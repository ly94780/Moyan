import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    build: { minify: 'esbuild' },
    // Markdown entity decoding must also work in the preview worker, which has no DOM.
    resolve: { conditions: ['worker', 'module', 'browser', 'development|production'] },
    plugins: [
      react(),
      {
        name: 'development-csp',
        apply: 'serve',
        transformIndexHtml(html) {
          return html
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace(
              "connect-src 'self'",
              "connect-src 'self' ws://localhost:* http://localhost:*",
            );
        },
      },
    ],
  },
});
