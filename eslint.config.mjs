// ESLint flat config (SUP-57).
//
// eslint-config-next 16 ships flat configs of its own, so they are imported
// directly. The old file ran them through @eslint/eslintrc's FlatCompat
// (`compat.extends("next/core-web-vitals", "next/typescript")`), which loads a
// flat array as if it were a legacy config and crashed before linting anything
// ("Converting circular structure to JSON"), so `npm run lint` never ran.
import { defineConfig } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Kept from the old config: the codebase reads untyped JSON columns as `any`.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "warn",
      "prefer-const": "warn",
      "react/no-unescaped-entities": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/purity": "warn",
    },
  },
  // Next's own ignores (.next, out, build, next-env.d.ts) come with nextTs.
]);
