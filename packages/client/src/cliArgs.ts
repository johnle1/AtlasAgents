/**
 * CLI flags for loopy / node dist/index.js — override server host and port per run.
 *
 * This module handles command-line argument parsing for the LoopyCode client.
 * It provides functionality to parse CLI flags, override configuration values,
 * and display help information. The CLI arguments allow users to temporarily
 * override server connection settings without modifying the config file.
 *
 * Key features:
 * - Parse standard CLI flags (--host, --port, --help)
 * - Validate port numbers (1-65535 range)
 * - Override config values for single session
 * - Display help text with usage examples
 */

// Import Node.js built-in utility for parsing command-line arguments
import { parseArgs } from "node:util";
// Import Config type to know which fields can be overridden
import type { Config } from "./config.js";

/**
 * <Summary>
 * What it does:
 *   Defines the shape of configuration values that can be overridden via CLI.
 *
 * How it fits in the system:
 *   Allows temporary override of server connection settings without modifying
 *   the persistent config file.
 *
 * Used by:
 *   - CliParseResult — uses this type for the overrides field.
 *
 * Produced by:
 *   - parseCliArgs — creates this object when parsing CLI arguments.
 * </Summary>
 */
export type CliOverrides = Partial<Pick<Config, "server" | "port">>;

/**
 * <Summary>
 * What it does:
 *   Defines the shape of the result from parsing CLI arguments.
 *
 * How it fits in the system:
 *   Encapsulates both the help flag status and any configuration overrides
 *   parsed from command-line arguments.
 *
 * Used by:
 *   - parseCliArgs — returns this type.
 *   - index.ts — uses this to determine if help should be shown and what overrides to apply.
 *
 * Produced by:
 *   - parseCliArgs — creates this object after parsing.
 * </Summary>
 */
export type CliParseResult = {
  /** Whether the user requested help (true when --help or -h is passed). */
  help: boolean;
  /** Configuration overrides parsed from CLI arguments (host and/or port). */
  overrides: CliOverrides;
};

/**
 * <Summary>
 * What it does:
 *   Parses a port string and validates it's within the valid port range.
 *
 * How it does it (step by step):
 *   1. Parses the string as a base-10 integer.
 *   2. Checks if the result is NaN or outside valid port range (1-65535).
 *   3. Returns undefined if invalid, otherwise returns the parsed number.
 *
 * Parameters:
 *   @param {string} raw — The port string to parse (e.g., "7000").
 *
 * Returns:
 *   @returns {number | undefined} — The parsed port number, or undefined if invalid.
 *
 * Dependencies:
 *   - Number.parseInt — converts string to integer.
 *   - Number.isNaN — checks if parsing failed.
 *
 * Dependants:
 *   - parseCliArgs — validates port argument before using it.
 * </Summary>
 */
const parsePort = (raw: string): number | undefined => {
  // Parse the raw string as a base-10 integer
  const n = Number.parseInt(raw, 10);
  // Check if parsing failed (NaN) or if outside valid port range (1-65535)
  if (Number.isNaN(n) || n < 1 || n > 65_535) {
    return undefined;
  }
  // Return the validated port number
  return n;
};

/**
 * <Summary>
 * What it does:
 *   Displays the CLI help text to the console.
 *
 * How it does it (step by step):
 *   1. Writes a formatted help string to stdout using console.log.
 *   2. Includes usage syntax, option descriptions, and examples.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {void} — called for side effects only.
 *
 * Dependencies:
 *   - console.log — outputs help text to terminal.
 *
 * Dependants:
 *   - index.ts — displays help when --help flag is passed or on parsing errors.
 * </Summary>
 */
export const printCliHelp = (): void => {
  console.log(`Usage: loopy [options] [start]

Connect to the LoopyCode RSocket server (options override ~/.agent-cli/config.json for this run only).

Options:
  -H, --host <host>       Server host (e.g. 0.0.0.0, localhost)
  -s, --server <host>     Same as --host
  -p, --port <port>       Server port (default from config, usually 7000)
  -h, --help              Show this help

Examples:
  loopy
  loopy start --host 0.0.0.0 --port 7000
`);
};

/**
 * <Summary>
 * What it does:
 *   Parses command-line arguments and extracts configuration overrides.
 *
 * How it does it (step by step):
 *   1. Calls Node.js parseArgs with the argument slice (skipping node and script).
 *   2. Defines options for host, server, port, and help flags.
 *   3. Allows positional arguments and non-strict mode for flexibility.
 *   4. If help flag is true, returns immediately with help=true and empty overrides.
 *   5. Initializes empty overrides object.
 *   6. Prefers --host over --server (both set same field, host takes precedence).
 *   7. Trims whitespace from host value and adds to overrides if non-empty.
 *   8. If port is provided, validates it using parsePort helper.
 *   9. Throws error if port is invalid, otherwise adds validated port to overrides.
 *   10. Returns result with help=false and any parsed overrides.
 *
 * Parameters:
 *   @param {string[]} argv — The process.argv array (command-line arguments).
 *
 * Returns:
 *   @returns {CliParseResult} — Object containing help flag and config overrides.
 *
 * Throws:
 *   @throws {Error} — When port argument is provided but invalid.
 *
 * Dependencies:
 *   - node:util.parseArgs — parses command-line arguments.
 *   - parsePort — validates port number format and range.
 *
 * Dependants:
 *   - index.ts — parses process.argv to get CLI overrides and help flag.
 * </Summary>
 */
export const parseCliArgs = (argv: string[]): CliParseResult => {
  // Parse command-line arguments using Node.js util, skipping first 2 args (node and script path)
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      host: { type: "string", short: "H" },
      server: { type: "string", short: "s" },
      port: { type: "string", short: "p" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  // If help flag is set, return early with help=true and no overrides
  if (values.help === true) {
    return { help: true, overrides: {} };
  }

  // Initialize empty overrides object to collect any CLI-provided config values
  const overrides: CliOverrides = {};
  // Extract host value: prefer --host over --server, trim whitespace, default to empty string
  const host =
    (typeof values.host === "string" ? values.host.trim() : "") ||
    (typeof values.server === "string" ? values.server.trim() : "");
  // Only add host to overrides if a non-empty value was provided
  if (host.length > 0) {
    overrides.server = host;
  }

  // Check if port argument was provided as a non-empty string
  if (typeof values.port === "string" && values.port.trim().length > 0) {
    // Validate the port using the parsePort helper function
    const port = parsePort(values.port.trim());
    // If port is invalid (undefined), throw an error with helpful message
    if (port === undefined) {
      throw new Error(
        `Invalid --port "${values.port}" (use an integer from 1 to 65535).`,
      );
    }
    // Port is valid, add it to overrides
    overrides.port = port;
  }

  // Return parsing result with help=false and any collected overrides
  return { help: false, overrides };
};

/**
 * <Summary>
 * What it does:
 *   Applies CLI overrides to a configuration object.
 *
 * How it does it (step by step):
 *   1. Spreads the original config object as base.
 *   2. Conditionally spreads server override if defined.
 *   3. Conditionally spreads port override if defined.
 *   4. Returns new config object with overrides applied.
 *
 * Parameters:
 *   @param {Config} config — The original configuration object.
 *   @param {CliOverrides} overrides — CLI overrides to apply (server and/or port).
 *
 * Returns:
 *   @returns {Config} — New configuration object with CLI overrides applied.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - index.ts — applies CLI overrides to loaded config before starting client.
 * </Summary>
 */
export const applyCliOverrides = (
  config: Config,
  overrides: CliOverrides,
): Config => ({
  ...config,
  ...(overrides.server !== undefined ? { server: overrides.server } : {}),
  ...(overrides.port !== undefined ? { port: overrides.port } : {}),
});
