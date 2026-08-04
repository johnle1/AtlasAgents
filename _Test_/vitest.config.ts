/**
 * Vitest configuration for the LoopyCode _Test_ suite.
 *
 * @remarks
 * This config covers three test layers housed in this folder:
 *  - unit/          — isolated function/module tests (fast, no I/O)
 *  - integration/   — wires multiple real modules together, mocks only
 *                     at the external boundary (no HTTP, no subprocess)
 *  - system/        — spawns the compiled CLI binary via execa (slow, needs dist/)
 *
 * Resolution strategy
 * -------------------
 * The client source uses `.js` extensions in every ESM import for Node
 * compatibility, e.g. `import foo from './bar.js'`. Vitest runs on the raw
 * TypeScript source, so we strip the `.js` suffix via a regex alias and let
 * Vite find the matching `.ts` file automatically.
 *
 * The `@loopycode/shared` workspace package is aliased directly to its
 * TypeScript source so we never need a pre-built dist/ for unit/integration
 * tests.
 */

import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    /** Run in a real Node.js environment — no DOM, no jsdom overhead. */
    environment: "node",

    /**
     * Match all three layers.
     * System tests use the `.e2e.test.ts` suffix so they can be run
     * independently with `vitest run system`.
     */
    include: [
      "unit/**/*.test.ts",
      "integration/**/*.test.ts",
      "system/**/*.e2e.test.ts",
    ],

    /**
     * Ink full-tree harnesses under unit/client/ui are opt-in / WIP — React 19
     * + ink-testing-library currently throws on several context-backed trees.
     * Only those specific harnesses are excluded by name; the Ink/smoke
     * import tests that live in the same folder (appInkSmoke, uiExportSmoke,
     * hooksHarness, etc.) DO run — no glob patterns here, so they can't be
     * accidentally matched.
     */
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "unit/client/ui/historyPersist.test.ts",
      "unit/client/ui/printDeclineFeedback.test.ts",
      "unit/client/ui/promptPort.test.ts",
      "unit/client/ui/runInkApp.test.ts",
    ],

    /**
     * System tests spawn a real subprocess and may wait for I/O; give them
     * enough room. Unit and integration tests should finish in milliseconds.
     */
    testTimeout: 20_000,

    /** Report coverage only when --coverage flag is passed explicitly. */
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["../packages/*/src/**/*.ts"],
      exclude: ["../packages/*/src/**/*.test.ts", "system/**"],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
        statements: 80,
      },
    },
  },

  resolve: {
    dedupe: ["react", "react-reconciler"],
    alias: [
      {
        find: "react",
        replacement: path.resolve(__dirname, "node_modules/react"),
      },
      {
        find: "react/jsx-runtime",
        replacement: path.resolve(__dirname, "node_modules/react/jsx-runtime"),
      },
      {
        find: "ink",
        replacement: path.resolve(__dirname, "node_modules/ink"),
      },
      {
        find: "ink-spinner",
        replacement: path.resolve(__dirname, "node_modules/ink-spinner"),
      },
      {
        find: "ink-text-input",
        replacement: path.resolve(__dirname, "node_modules/ink-text-input"),
      },
      /**
       * Strip `.js` from relative imports so Vitest finds `.ts` source files.
       *
       * The client source writes `import x from './foo.js'` for Node ESM
       * compliance, but Vitest runs TypeScript directly. This alias transparently
       * redirects those imports to the real `.ts` files without touching source.
       *
       * Example: `'../../packages/client/src/ui/spinnerSync.js'`
       *       → `'../../packages/client/src/ui/spinnerSync'`   (Vitest finds .ts)
       */
      { find: /^(.+)\.js$/, replacement: "$1" },

      /**
       * Map the `@loopycode/shared` package to its TypeScript source directly.
       * This avoids requiring a prior `tsc` build of the shared package.
       */
      {
        find: "@loopycode/shared",
        replacement: path.resolve(
          __dirname,
          "../packages/shared/src/index.ts",
        ),
      },
    ],
  },
});
