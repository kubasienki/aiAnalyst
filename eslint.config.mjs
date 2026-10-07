import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    files: ["src/server/agent/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/conversations/**", "**/context/**", "**/adapters/**", "**/config/**", "next", "next/**"],
          message: "Agent execution depends on its own contracts. Translate domain failures in composition or application adapters.",
        }],
      }],
    },
  },
  globalIgnores([".next/**", "out/**", "coverage/**", "private-files/**", "next-env.d.ts"]),
]);
