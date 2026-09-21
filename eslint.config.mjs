import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  { ignores: ["dist/", "node_modules/", "src/data/geo/"] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  prettier,
];
