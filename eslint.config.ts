// @ts-expect-error - no types available
import enk0ded from 'eslint-config-enk0ded';
import globals from 'globals';

export default [
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  ...enk0ded,
  {
    ignores: [
      '@OLD',
      'node_modules',
      'watcher',
      './browser.js',
      './index.d.ts',
      './index.js',
      './wasi-worker-browser.mjs',
      './wasi-worker.mjs',
      './watcher.wasi-browser.js',
      './watcher.wasi.cjs',
    ],
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
      parserOptions: { projectService: { allowDefaultProject: ['*.config.js'] } },
      sourceType: 'module',
    },
  },
];
