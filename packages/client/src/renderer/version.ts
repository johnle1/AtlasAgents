import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * CLI version from package.json.
 */
export const CLI_VERSION = (
  require("../../package.json") as { version: string }
).version;
