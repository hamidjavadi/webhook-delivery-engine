import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:console',
              message:
                'Please use the application structured logger (pino) instead of node:console.',
            },
            {
              name: 'console',
              message:
                'Please use the application structured logger (pino) instead of console.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'tests/**/*.ts',
      'test/**/*.ts',
      '**/*.spec.ts',
      '**/*.test.ts',
      'scripts/**/*.ts',
    ],
    rules: {
      'no-console': 'off',
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
