import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources (see "source" in each package's exports).
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
