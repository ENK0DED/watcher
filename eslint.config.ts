// @ts-expect-error - no types available
import enk0ded from 'eslint-config-enk0ded';
import globals from 'globals';

export default [
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  ...enk0ded,
  {
    ignores: ['@OLD', 'node_modules', 'watcher', './index.d.ts', './index.js'],
  },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.browser,
        ...globals.bunBuiltin,
        ...globals.es2026,
        ...globals.node,
      },
      parserOptions: { projectService: true },
      sourceType: 'module',
    },
  },
];
