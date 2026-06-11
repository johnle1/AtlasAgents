import type { Config } from "../config.js";
import { buildBannerLines as buildBannerLinesImpl } from "../ui/banner/buildBannerLines.js";
import { CLI_VERSION } from "./version.js";

export const buildBannerLines = (config: Config): string[] =>
  buildBannerLinesImpl(config, CLI_VERSION);
