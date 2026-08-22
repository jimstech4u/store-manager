// eslint.config.mjs
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import pluginReact from 'eslint-plugin-react';
import pluginReactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        // Next replaces `process.env.NEXT_PUBLIC_*` at build time, so it is legitimate in client
        // code even though `process` itself never exists in the browser. Declared readonly so a
        // genuine attempt to USE the Node API is still flagged.
        process: 'readonly',
        React: 'readonly',
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    plugins: {
      js,
      '@typescript-eslint': tseslint.plugin,
      react: pluginReact,
      'react-hooks': pluginReactHooks,
      // Must be registered as '@next/next', not 'next': the rules this plugin ships are named
      // '@next/next/…', and a mismatched key means every one of them fails to resolve — so the
      // whole config errors out and no linting happens at all.
      '@next/next': nextPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended[0].rules,
      ...pluginReact.configs.flat.recommended.rules,
      ...pluginReactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      // The base rule does not understand TypeScript, so it reports parameter names in TYPE
      // signatures (`setTheme: (t: StoredTheme) => void`) as unused variables. Turn it off and
      // let the TS-aware version do the job — running both means real findings get lost among
      // false ones, which is how a lint step stops being read.
      'no-unused-vars': 'off',
      // Same class of problem, and the same fix. `no-undef` predates TypeScript and has no idea
      // that `CanvasImageSource` or `RequestInit` are types rather than variables, so it reports
      // every type-only DOM global as undefined. tsc already rejects genuinely undefined
      // identifiers — and does it correctly — so this rule can only produce false positives here.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'react/prop-types': 'off',
    },
  },
]);
