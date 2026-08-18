/**
 * Types for CLI argument parsing and config repair.
 *
 * @remarks
 * Defines the types used for parsing CLI flags and managing config repair mode.
 * Split from cliArgs.ts to separate type definitions from parsing logic.
 */

import type { Config } from "../config/index.js";

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
 * Connection settings to write to config.json in config-repair mode.
 *
 * @remarks
 * Unlike {@link CliOverrides}, everything here is *persisted*. The request is
 * built only when the user passes at least one of `--reset`, `--password`, or
 * `--address`; see {@link parseCliArgs}.
 *
 * `password` is a boolean rather than a string on purpose — the value is never
 * accepted on the command line (it would land in shell history and `ps`
 * output), only via a masked prompt.
 *
 * @example
 * // atlas --reset --address 10.0.0.7 --port 8001 --password
 * const request: ConfigRepairRequest = {
 *   reset: true,
 *   password: true,
 *   server: "10.0.0.7",
 *   port: 8001,
 * };
 */
export type ConfigRepairRequest = {
  /** Clear the saved password, address, port, and pinned TLS fingerprints. */
  reset: boolean;
  /** Prompt for a new server password and save it. */
  password: boolean;
  /** New server address to save, when `--address` (or `--host`) was given. */
  server?: string;
  /** New server port to save, when `--port` was given. */
  port?: number;
  /**
   * Clear the pinned TLS fingerprint for the resolved server:port, when
   * `--trust-fingerprint` was given. Lets the next connection re-TOFU-pin a
   * legitimately rotated server certificate. Ignored when `reset` is set,
   * since reset already clears every pinned fingerprint.
   */
  trustFingerprint?: boolean;
};

/**
 * Result from parsing CLI arguments.
 *
 * @remarks
 * Encapsulates the help flag, any session-only configuration overrides, and —
 * in config-repair mode — the settings to persist. `overrides` and `repair`
 * are mutually exclusive: in repair mode the parsed host/port go into
 * `repair` and `overrides` is left empty, because a repair run exits before
 * any connection is attempted and has nothing to override.
 *
 * @example
 * const result = parseCliArgs(process.argv);
 * if (result.help) {
 *   printCliHelp();
 * } else if (result.repair) {
 *   await runConfigRepair(result.repair);
 * } else {
 *   const config = applyCliOverrides(loadConfig(), result.overrides);
 * }
 */
export type CliParseResult = {
  /** Whether the user requested help (true when --help or -h is passed). */
  help: boolean;
  /** Session-only configuration overrides (host and/or port). */
  overrides: CliOverrides;
  /** Settings to persist, set only in config-repair mode. */
  repair?: ConfigRepairRequest;
};
