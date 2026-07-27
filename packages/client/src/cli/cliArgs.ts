/**
 * CLI argument parsing for the LoopyCode client.
 *
 * @remarks
 * This module handles command-line argument parsing for the LoopyCode client.
 * It provides functionality to parse CLI flags, override configuration values,
 * and display help information.
 *
 * The flags fall into two distinct modes:
 *
 * 1. **Session overrides** (`--host`/`--server`/`--port`): temporarily point
 *    this one run at a different server without touching config.json.
 * 2. **Config repair** (`--reset`/`--password`/`--address`): persist new
 *    connection settings and exit, without ever contacting the server. This
 *    exists because every other way to change these settings (`/set server`,
 *    `/set port`, `/set password`) only becomes reachable *after* a successful
 *    connection — so an operator-side password/port/IP change would otherwise
 *    lock the client out with no way back in.
 *
 * Passing any of `--reset`, `--password`, or `--address` switches the whole
 * invocation into config-repair mode, and `--port` given alongside them is
 * persisted rather than treated as a session override.
 *
 * Key features:
 * - Parse standard CLI flags (--host, --port, --help)
 * - Validate port numbers (1-65535 range)
 * - Override config values for single session
 * - Persist connection settings offline via config-repair mode
 * - Display help text with usage examples
 */

import { parseArgs } from "node:util";
import type { Config } from "../config/index.js";
import type { CliOverrides, CliParseResult } from "./types.js";

export type { CliOverrides, CliParseResult, ConfigRepairRequest } from "./types.js";

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

Config repair (saves to config.json and exits — no server connection needed,
asks for your config passphrase first):
  -a, --address <host>    Save a new server address
      --port <port>       Save a new port (alongside --reset/--password/--address)
      --password          Prompt for and save a new server password
      --reset             Clear the saved password, address, port, and pinned
                          TLS certificate fingerprints
      --trust-fingerprint Clear the pinned TLS certificate fingerprint for the
                          configured server (re-trust on next connect)

Examples:
  loopy
  loopy start --host 0.0.0.0 --port 7000
  loopy --address 10.0.0.7 --port 8001 --password
  loopy --reset
`);
};

/**
 * Reads a string flag's trimmed value out of a `parseArgs` result.
 *
 * @remarks
 * `parseArgs` runs in non-strict mode here, so a flag can come back as a
 * boolean (when written without a value) or as an array (when repeated). Both
 * are treated as absent — only a real string counts.
 *
 * @param value - The raw value `parseArgs` produced for one flag.
 * @returns The trimmed string, or an empty string when not usably present.
 */
const readStringFlag = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * Detects `--password <value>`, which silently discards the value.
 *
 * @remarks
 * `--password` is declared as a boolean, and `parseArgs` runs with
 * `strict: false` and `allowPositionals: true` — so `loopy --password hunter2`
 * parses cleanly, ignores `hunter2`, and prompts anyway. The user's secret is
 * then sitting in shell history and `ps` output for nothing. Better to fail
 * loudly than to silently discard it.
 *
 * The documented `start` positional is excluded, so `loopy --password start`
 * is read as "prompt me, and start" rather than as a leaked secret.
 *
 * @param args - The argument list passed to `parseArgs` (argv minus node/script).
 * @returns true when a non-flag token directly follows `--password`.
 */
const hasInlinePasswordValue = (args: string[]): boolean => {
  const passwordIndex = args.indexOf("--password");
  if (passwordIndex === -1) {
    return false;
  }
  const nextToken = args[passwordIndex + 1];
  return (
    nextToken !== undefined &&
    !nextToken.startsWith("-") &&
    nextToken !== "start"
  );
};

/**
 * Checks whether any spelling of a flag appears in the raw argument list.
 *
 * @remarks
 * Needed because flag *presence* and flag *value* are different questions
 * here: `--address` with no value parses to `undefined` (same as absent), and
 * `--address=host` never appears as a standalone token. Both must still count
 * as "the user asked for config-repair mode".
 *
 * @param args - The argument list passed to `parseArgs`.
 * @param names - Every spelling to look for, e.g. `["--address", "-a"]`.
 * @returns true when any of `names` is present, with or without a value.
 */
const hasFlag = (args: string[], names: string[]): boolean =>
  args.some((arg) =>
    names.some((name) => arg === name || arg.startsWith(`${name}=`)),
  );

/**
 * Parses command-line arguments into session overrides or a config-repair request.
 *
 * @remarks
 * This function parses CLI arguments using Node.js parseArgs utility. It handles
 * the following:
 * - Skips the first two arguments (node executable and script path)
 * - Supports --host/-H, --server/-s, --address/-a, --port/-p, --password,
 *   --reset, and --help/-h flags
 * - Prefers --address, then --host, then --server if several are provided
 * - Validates port numbers are within valid range (1-65535)
 * - Returns early with help=true if --help flag is present
 * - Returns a `repair` request instead of `overrides` when --reset, --password,
 *   or --address is present, which is what lets connection settings be changed
 *   while the client cannot reach the server
 *
 * @param argv - The process.argv array (command-line arguments).
 * @returns Object containing the help flag plus either session overrides or a
 *   config-repair request.
 * @throws When the port argument is invalid, `--address` is empty, or
 *   `--password` was given an inline value.
 *
 * @example
 * const result = parseCliArgs(process.argv);
 * if (result.help) {
 *   printCliHelp();
 * } else if (result.repair) {
 *   console.log("Repairing config, not connecting.");
 * } else {
 *   console.log(`Connecting to ${result.overrides.server}:${result.overrides.port}`);
 * }
 */
export const parseCliArgs = (argv: string[]): CliParseResult => {
  const args = argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      host: { type: "string", short: "H" },
      server: { type: "string", short: "s" },
      address: { type: "string", short: "a" },
      port: { type: "string", short: "p" },
      password: { type: "boolean", default: false },
      reset: { type: "boolean", default: false },
      "trust-fingerprint": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help === true) {
    return { help: true, overrides: {} };
  }

  // --address is the config-repair spelling of the host; --host/--server are
  // accepted as aliases so `loopy --reset --host x` does the obvious thing.
  const address = readStringFlag(values.address);
  const host =
    address ||
    readStringFlag(values.host) ||
    readStringFlag(values.server);

  const wantsReset = values.reset === true;
  const wantsPassword = values.password === true;
  const wantsTrustFingerprint = values["trust-fingerprint"] === true;
  // Presence is read from argv rather than from `values.address`, because a
  // valueless `--address` at the end of the line parses to undefined and would
  // otherwise be indistinguishable from not passing the flag at all.
  const gaveAddressFlag = hasFlag(args, ["--address", "-a"]);

  if (wantsPassword && hasInlinePasswordValue(args)) {
    throw new Error(
      "--password takes no value; you will be prompted for it (so it stays out of your shell history).",
    );
  }

  // A leading "-" means parseArgs swallowed the following flag as the value
  // (`--address --reset`), which would otherwise be saved as a literal host.
  if (gaveAddressFlag && (address.length === 0 || address.startsWith("-"))) {
    throw new Error("Invalid --address (provide a host name or IP address).");
  }

  // Only an explicit --reset/--password/--address/--trust-fingerprint switches
  // modes. --host/--port on their own keep their long-standing session-only
  // meaning.
  const isRepairMode =
    wantsReset || wantsPassword || gaveAddressFlag || wantsTrustFingerprint;

  let port: number | undefined;
  const rawPort = readStringFlag(values.port);
  if (rawPort.length > 0) {
    port = parsePort(rawPort);
    if (port === undefined) {
      throw new Error(
        `Invalid --port "${values.port}" (use an integer from 1 to 65535).`,
      );
    }
  }

  if (isRepairMode) {
    return {
      help: false,
      overrides: {},
      repair: {
        reset: wantsReset,
        password: wantsPassword,
        trustFingerprint: wantsTrustFingerprint,
        ...(host.length > 0 ? { server: host } : {}),
        ...(port !== undefined ? { port } : {}),
      },
    };
  }

  const overrides: CliOverrides = {
    ...(host.length > 0 ? { server: host } : {}),
    ...(port !== undefined ? { port } : {}),
  };

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
