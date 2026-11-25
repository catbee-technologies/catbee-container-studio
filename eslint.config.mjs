import electronEslint from '@electron-toolkit/eslint-config-ts';
import electronConfigPrettier from '@electron-toolkit/eslint-config-prettier';
import nodePlugin from 'eslint-plugin-n';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'ignore-paths',
    ignores: ['dist/', 'reports/', 'data/', 'build/', 'frontend/']
  },
  ...electronEslint.configs.recommended,
  {
    ...nodePlugin.configs['flat/recommended-module'],
    name: 'node-plugin',
    files: ['**/*.ts'],
    rules: {
      'n/no-process-env': 'error',
      'n/no-missing-import': 'off'
    },
    languageOptions: {
      globals: {
        ...globals.node,
        NodeJS: true
      }
    }
  },
  {
    ...nodePlugin.configs['flat/recommended-module'],
    name: 'node-plugin-tests',
    files: ['tests*/**/*.ts'],
    rules: {
      'n/no-process-env': 'off'
    },
    languageOptions: {
      globals: {
        ...globals.jest
      }
    }
  },
  {
    name: 'catbee-rules',
    rules: {
      'no-console': 'error',
      eqeqeq: ['error', 'smart'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'error',
      'no-control-regex': 'off'
    }
  },
  electronConfigPrettier
];
