import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    globals: false,
    // node:sqlite é um builtin novo que o bundler do Vite ainda não reconhece;
    // força tratá-lo como externo (resolvido pelo runtime do Node).
    server: {
      deps: {
        external: [/node:sqlite/],
      },
    },
  },
});
