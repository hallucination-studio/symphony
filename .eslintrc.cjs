module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    project: false
  },
  env: {
    es2022: true,
    node: true,
    browser: true
  },
  ignorePatterns: ["**/dist/**", "**/generated/**", "**/target/**"]
};
