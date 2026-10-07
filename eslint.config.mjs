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
  {
    files: ["src/server/analysis/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/conversations/**"],
          message: "Analysis and conversations are separate contexts. Shared query evidence lives in src/server/evidence/contracts.",
        }],
      }],
    },
  },
  {
    files: ["src/features/**/*.ts", "src/features/**/*.tsx", "src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/server/**"],
          message: "Client and shared modules must stay free of server code. Exchange data through the schemas in src/shared.",
        }],
      }],
    },
  },
  globalIgnores([".next/**", "out/**", "coverage/**", "private-files/**", "next-env.d.ts"]),
]);
