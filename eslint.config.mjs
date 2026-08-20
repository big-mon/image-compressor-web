import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        document: 'readonly',
        process: 'readonly',
        window: 'readonly',
      },
    },
  },
)
