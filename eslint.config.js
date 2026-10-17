import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // C9: nothing but JSON-RPC may reach stdout in stdio mode.
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='stdout'][property.name='write']",
          message: 'Do not write to stdout; use the stderr logger (C9).',
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/lib/logger.ts', 'scripts/**', 'test/**'],
    rules: { 'no-console': 'off', 'no-restricted-syntax': 'off' },
  },
);
