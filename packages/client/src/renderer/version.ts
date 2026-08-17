/**
 * CLI package version string sourced from `packages/client/package.json`.
 *
 * @remarks
 * Resolved at module load via `createRequire` so ESM can read nearby JSON.
 * Used by the ANSI/Ink startup banner title (`AtlasAgents CLI v…`).
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Semver (or package) version displayed in the CLI banner.
 *
 * @example
 * ```ts
 * console.log(CLI_VERSION); // e.g. "0.4.0"
 * ```
 */
export const CLI_VERSION = (
  require("../../package.json") as { version: string }
).version;
