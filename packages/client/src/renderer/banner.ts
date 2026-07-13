/**
 * Thin wrapper that builds ANSI banner lines with the packaged CLI version.
 *
 * @remarks
 * Art and layout live in `ui/banner/buildBannerLines`. This module injects
 * {@link CLI_VERSION} so call sites only pass {@link Config}.
 */

import type { Config } from "../config.js";
import { buildBannerLines as buildBannerLinesImpl } from "../ui/banner/buildBannerLines.js";
import { CLI_VERSION } from "./version.js";

/**
 * Builds themed ANSI startup-banner lines for the current config.
 *
 * @param config - Client config (models shown on the banner footer lines).
 * @returns One ANSI string per terminal row.
 *
 * @example
 * ```ts
 * for (const line of buildBannerLines(loadConfig())) {
 *   console.log(line);
 * }
 * ```
 */
export const buildBannerLines = (config: Config): string[] =>
  buildBannerLinesImpl(config, CLI_VERSION);
