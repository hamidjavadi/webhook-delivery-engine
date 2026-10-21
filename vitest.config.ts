import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'src/app/**/*.ts',
        'src/features/ingestion/**/*.ts',
        'src/security/**/*.ts',
        'src/storage/**/*.ts',
      ],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        'src/features/ingestion/ingestion.schema.ts': {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
        'src/security/ssrf.ts': {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
      },
    },
  },
});
