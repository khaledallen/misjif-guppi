import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["functions/lib/"]),
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    // Tests match literal two-space indents in diff output.
    files: ["**/test/**"],
    rules: { "no-regex-spaces": "off" },
  },
  {
    // Type-aware rules (no-floating-promises etc.) need functions/node_modules installed.
    files: ["functions/src/**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
);
