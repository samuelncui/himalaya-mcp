import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['build/**', 'dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
);
