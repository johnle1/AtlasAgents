/**
 * Keeps an `examples/mcp-server`-spawning e2e test from silently skipping
 * in CI.
 *
 * @remarks
 * `_Test_/system/mcpStdioServer.e2e.test.ts` and `mcpHttpServer.e2e.test.ts`
 * both spawn `examples/mcp-server/dist/*.js` as a real subprocess, and both
 * degrade to `it.skip` locally when that directory hasn't been built —
 * useful on a dev machine that hasn't run `npm run build` in the example
 * yet. But the same skip must never happen quietly in CI: if the `system`
 * job's build step ever regresses (a workflow edit, a script rename), this
 * turns that into a loud, immediate failure instead of every affected test
 * vanishing from the report.
 *
 * Call this once per file, right after computing `ENTRY_EXISTS`.
 *
 * @param label - Name of the missing entry point, for the error message
 *   (e.g. `"examples/mcp-server/dist/stdio.js"`).
 * @param entryExists - Whether the build artifact was found on disk.
 * @throws {Error} When running under CI (`process.env.CI` truthy) and
 *   `entryExists` is `false`.
 */
export const assertBuiltUnderCi = (label: string, entryExists: boolean): void => {
  if (process.env.CI && !entryExists) {
    throw new Error(
      `${label} is missing under CI — the "system" job in .github/workflows/test.yml ` +
        `must build examples/mcp-server before running _Test_'s e2e suite. ` +
        `This is a hard failure (not a skip) specifically so this regression can't hide.`,
    );
  }
};
