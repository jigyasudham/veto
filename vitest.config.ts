import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    setupFiles: ['tests/setup/isolate-config.ts'],
    env: {
      VETO_TEST_DB: ':memory:',
    },
  },
});
