import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import svelteConfig from './svelte.config.js';

export default ts.config(
  {
    ignores: [
      'dist/',
      '**/dist/',
      'dev-dist/',
      'node_modules/',
      'vendor/',
      'public/',
      'docs/',
      'playwright-report/',
      'test-results/',
      'coverage/',
      '.cache/',
      // The editor plugins' build outputs: Gradle's and cargo's.
      'editors/clion/**/build/',
      'editors/zed/target/',
    ],
  },
  js.configs.recommended,
  ...ts.configs.strictTypeChecked,
  ...ts.configs.stylisticTypeChecked,
  ...svelte.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off', // used deliberately after noUncheckedIndexedAccess checks
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // State holds plain Map/Set values that are replaced wholesale ($state.raw + reassignment), never mutated in place.
      'svelte/prefer-svelte-reactivity': 'off',
      '@typescript-eslint/no-empty-function': [
        'error',
        { allow: ['arrowFunctions', 'methods', 'asyncMethods'] },
      ],
      eqeqeq: ['error', 'always'],
      curly: ['error', 'multi-line'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: { parser: ts.parser, svelteConfig, extraFileExtensions: ['.svelte'] },
    },
  },
  {
    // Fakes of async interfaces (a compiler, the engine) answer at once.
    files: ['editors/**/test/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    files: ['tools/**/*.mjs', '*.js'],
    ...ts.configs.disableTypeChecked,
    languageOptions: { globals: globals.node },
  },
);
