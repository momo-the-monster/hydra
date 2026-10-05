import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  // Use the TypeScript sources of the workspace packages (see "source" in their exports).
  resolve: { conditions: ['source', ...defaultClientConditions] },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: { main: 'index.html', host: 'host.html' },
    },
  },
});
