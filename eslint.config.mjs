import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

const eslintConfig = [
  ...nextCoreWebVitals,
  {
    ignores: ['.next/**', 'node_modules/**', 'dist/**', 'security/**'],
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // Existing client pages intentionally initialise UI-only state after
      // hydration; this React Compiler advisory is not a correctness error.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
];

export default eslintConfig;
