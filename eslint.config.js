// Lint catches real mistakes only (undefined names, duplicate keys, unreachable code…), not style.
// Run: npm run lint
const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-control-regex': 'off',
  'no-useless-escape': 'off',
  'no-prototype-builtins': 'off',
  'no-cond-assign': ['error', 'except-parens'],
};

module.exports = [
  { ignores: ['node_modules/**', '**/*.min.js', 'extension/dashboard.js', 'extension/popup.js'] }, // minified builds
  { files: ['server.js', 'src/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } }, rules },
  { files: ['public/**/*.js', 'extension/**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser, ...globals.webextensions, chrome: 'readonly' } }, rules },
];
