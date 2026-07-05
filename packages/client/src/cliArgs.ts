/**
 * CLI argument parsing for the LoopyCode client.
 *
 * @remarks
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

import { parseArgs } from "node:util";
import type { Config } from "./config.js";

/**
 * Configuration values that can be overridden via CLI arguments.
 *
 * @remarks
 * This type allows temporary override of server connection settings without
 * modifying the persistent config file. Only server and port can be overridden
 * via CLI flags.
 *
 * @example
 * const overrides: CliOverrides = {
 *   server: "localhost",
 *   port: 7000
 * };
 */
export type CliOverrides = Partial<Pick<Config, "server" | "port">>;

/**
 * Result from parsing CLI arguments.
 *
 * @remarks
 * Encapsulates both the help flag status and any configuration overrides
 * parsed from command-line arguments.
 *
 * @example
 * const result = parseCliArgs(process.argv);
 * if (result.help) {
 *   printCliHelp();
 * } else {
 *   const config = applyCliOverrides(loadConfig(), result.overrides);
 * }
 */
export type CliParseResult = {
  /** Whether the user requested help (true when --help or -h is passed). */
  help: boolean;
  /** Configuration overrides parsed from CLI arguments (host and/or port). */
  overrides: CliOverrides;
};

/**
 * Parses a port string and validates it's within the valid port range.
 *
 * @remarks
 * This function parses a string as a base-10 integer and validates that it
 * falls within the valid TCP/UDP port range (1-65535). Returns undefined if
 * the string is not a valid number or is outside the valid range.
 *
 * @param raw - The port string to parse (e.g., "7000").
 * @returns The parsed port number, or undefined if invalid.
 *
 * @example
 * const port = parsePort("7000"); // 7000
 * const invalid = parsePort("99999"); // undefined
 * const notANumber = parsePort("abc"); // undefined
 */
const parsePort = (raw: string): number | undefined => {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1 || n > 65_535) {
    return undefined;
  }
  return n;
};

/**
 * Displays the CLI help text to the console.
 *
 * @remarks
 * This function writes a formatted help string to stdout including usage syntax,
 * option descriptions, and examples. It is called when the user passes --help
 * or -h flags, or when CLI argument parsing fails.
 *
 * @example
 * printCliHelp();
 * // Output:
 * // Usage: loopy [options] [start]
 * // ...
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
 * Parses command-line arguments and extracts configuration overrides.
 *
 * @remarks
 * This function parses CLI arguments using Node.js parseArgs utility and extracts
 * configuration overrides for server and port. It handles the following:
 * - Skips the first two arguments (node executable and script path)
 * - Supports --host/-H, --server/-s, --port/-p, and --help/-h flags
 * - Prefers --host over --server if both are provided
 * - Validates port numbers are within valid range (1-65535)
 * - Returns early with help=true if --help flag is present
 *
 * @param argv - The process.argv array (command-line arguments).
 * @returns Object containing help flag and config overrides.
 * @throws When port argument is provided but invalid.
 *
 * @example
 * const result = parseCliArgs(process.argv);
 * if (result.help) {
 *   printCliHelp();
 * } else {
 *   console.log(`Connecting to ${result.overrides.server}:${result.overrides.port}`);
 * }
 */
export const parseCliArgs = (argv: string[]): CliParseResult => {
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

  if (values.help === true) {
    return { help: true, overrides: {} };
  }

  const overrides: CliOverrides = {};
  const host =
    (typeof values.host === "string" ? values.host.trim() : "") ||
    (typeof values.server === "string" ? values.server.trim() : "");
  if (host.length > 0) {
    overrides.server = host;
  }

  if (typeof values.port === "string" && values.port.trim().length > 0) {
    const port = parsePort(values.port.trim());
    if (port === undefined) {
      throw new Error(
        `Invalid --port "${values.port}" (use an integer from 1 to 65535).`,
      );
    }
    overrides.port = port;
  }

  return { help: false, overrides };
};

/**
 * Applies CLI overrides to a configuration object.
 *
 * @remarks
 * This function creates a new config object with CLI overrides applied. Only
 * fields that are defined in the overrides object are modified; all other
 * fields remain unchanged. This allows temporary configuration changes for a
 * single CLI session without modifying the persistent config file.
 *
 * @param config - The original configuration object.
 * @param overrides - CLI overrides to apply (server and/or port).
 * @returns New configuration object with CLI overrides applied.
 *
 * @example
 * const config = loadConfig();
 * const overrides = { server: "localhost", port: 7000 };
 * const overriddenConfig = applyCliOverrides(config, overrides);
 * console.log(overriddenConfig.server); // "localhost"
 */
export const applyCliOverrides = (
  config: Config,
  overrides: CliOverrides,
): Config => ({
  ...config,
  ...(overrides.server !== undefined ? { server: overrides.server } : {}),
  ...(overrides.port !== undefined ? { port: overrides.port } : {}),
});
