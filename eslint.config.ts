/* eslint-disable n/no-unpublished-import */
import enk0ded from 'eslint-config-enk0ded';
import globals from 'globals';

export default [
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  ...enk0ded,
  { ignores: ['node_modules', 'watcher'] },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.browser,
        ...globals.bunBuiltin,
        ...globals.es2026,
        ...globals.node,
      },
      parserOptions: { projectService: { allowDefaultProject: ['eslint.config.ts', '*.config.js'] } },
      sourceType: 'module',
    },
  },
];
