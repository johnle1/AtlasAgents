/**
 * CLI argument parsing for `atlas-server`.
 *
 * @remarks
 * Mirrors the client's `cli/cliArgs.ts`: flags fall into two modes.
 *
 * 1. **Start** (no repair flags): the existing interactive flow — prompt for
 *    whatever hasn't been saved yet, then listen for connections.
 * 2. **Config repair** (`--reset`/`--password`/`--port`): change the saved
 *    auth password and/or TCP port and exit, without starting the server.
 *    `--reset` prompts for a new password and port to replace the old ones.
 *    Requires the correct server-config passphrase — see
 *    `cli/serverConfigRepair.ts` for why a wrong entry here must fail closed
 *    rather than offering the forgot-passphrase reset menu that `start` has.
 *
 * `--regen-cert` and `help`/`--help`/`-h` are unchanged from before this
 * module existed; they're folded in here just so `main()` has a single parse
 * call instead of several passes over raw `argv`.
 */

import { parseArgs } from "node:util";

/**
 * Settings to persist in config-repair mode.
 *
 * @remarks
 * `port` is `"prompt"` when `--port` was given with no value (interactive:
 * run the same port prompt `start` uses), a number when given a value, or
 * absent when `--port` wasn't passed at all. `password` is a boolean rather
 * than a string for the same reason as the client's `ConfigRepairRequest`:
 * accepting the value inline would leave it sitting in shell history and
 * `ps` output, so it's only ever collected via a masked prompt.
 */
export type ServerRepairRequest = {
  /**
   * Prompt for a new password and port, replacing the old ones (passphrase
   * and provider keys are untouched).
   */
  reset: boolean;
  /** Prompt for a new server password and save it. */
  password: boolean;
  /** New port to save: a validated number, or `"prompt"` for bare `--port`. */
  port?: number | "prompt";
};

/** Result of parsing `process.argv` for `atlas-server`. */
export type ServerCliParseResult = {
  help: boolean;
  regenCert: boolean;
  /** Present only in config-repair mode. */
  repair?: ServerRepairRequest;
  /**
   * The first non-flag argument (e.g. `"start"`), if any — used to reject an
   * unrecognized command. Read from `parseArgs`'s positionals rather than
   * raw `argv[0]`, so a flag like `--port` appearing before (or instead of)
   * a positional doesn't get misread as the command itself.
   */
  command?: string;
};

/**
 * Parses a port string and validates it's within the valid port range.
 *
 * @param raw - The port string to parse (e.g., "7000").
 * @returns The parsed port number, or undefined if invalid.
 */
const parsePort = (raw: string): number | undefined => {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1 || n > 65_535) {
    return undefined;
  }
  return n;
};

/**
 * True when `command` is absent or the documented launch verb (`start` / `run`).
 *
 * @remarks
 * Bare `atlas-server` and `atlas-server start` are the same flow. `run` is
 * accepted as an alias so operators who type that by habit are not rejected.
 * Any other positional is an unknown command and must fail closed in `main`.
 *
 * @param command - First non-flag argument from {@link parseServerArgs}, if any.
 */
export const isServerLaunchCommand = (command: string | undefined): boolean =>
  command === undefined ||
  command === "" ||
  command === "start" ||
  command === "run";

/**
 * Detects `--password <value>`, which would otherwise silently discard the
 * value: `--password` is declared boolean, and `parseArgs` runs with
 * `strict: false`, so `atlas-server --password hunter2` parses cleanly,
 * ignores `hunter2`, and prompts anyway — leaving the secret sitting in
 * shell history and `ps` output for nothing. Better to fail loudly.
 *
 * @param args - The argument list passed to `parseArgs` (argv minus node/script).
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
    nextToken !== "start" &&
    nextToken !== "run"
  );
};

/**
 * Displays the CLI help text.
 */
export const printServerHelp = (): string =>
  `Usage:
  atlas-server [start|run]  Interactive startup, then listen for RSocket clients
  atlas-server --regen-cert Rotate the TLS certificate (asks for confirmation)

Config repair (saves to user-data/startup.json and exits — no listening,
asks for your server config passphrase first):
  --port [port]  Save a new TCP port (omit the value to be prompted)
  --password     Prompt for and save a new server auth password
  --reset        Prompt for a new password and port, replacing the old ones;
                 leaves the passphrase and provider keys alone

Examples:
  atlas-server
  atlas-server start
  atlas-server run
  atlas-server --port 8001
  atlas-server --password
  atlas-server --reset --port 8001
  atlas-server --regen-cert`;

/**
 * Parses `process.argv` into a start command, `--regen-cert`, or a
 * config-repair request.
 *
 * @param argv - `process.argv`.
 * @throws When `--port` is given an invalid or flag-shaped value, or
 *   `--password` was given an inline value.
 */
export const parseServerArgs = (argv: string[]): ServerCliParseResult => {
  const args = argv.slice(2);
  const { values, positionals } = parseArgs({
    args,
    options: {
      password: { type: "boolean", default: false },
      port: { type: "string" },
      reset: { type: "boolean", default: false },
      "regen-cert": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0];

  if (values.help === true || command === "help") {
    return { help: true, regenCert: false };
  }

  if (values["regen-cert"] === true) {
    return { help: false, regenCert: true };
  }

  const wantsReset = values.reset === true;
  const wantsPassword = values.password === true;

  if (wantsPassword && hasInlinePasswordValue(args)) {
    throw new Error(
      "--password takes no value; you will be prompted for it (so it stays out of your shell history).",
    );
  }

  // parseArgs gives a string only when --port was followed by a token that
  // isn't itself consumed as another flag's value; `true` means bare --port
  // (prompt); absent means --port wasn't passed at all.
  let port: number | "prompt" | undefined;
  const rawPort = values.port;
  if (typeof rawPort === "string") {
    if (rawPort.startsWith("-")) {
      throw new Error(
        `Invalid --port "${rawPort}" (looks like another flag — pass a port number, or omit the value to be prompted).`,
      );
    }
    const parsed = parsePort(rawPort);
    if (parsed === undefined) {
      throw new Error(
        `Invalid --port "${rawPort}" (use an integer from 1 to 65535).`,
      );
    }
    port = parsed;
  } else if (rawPort === true) {
    port = "prompt";
  }

  const isRepairMode = wantsReset || wantsPassword || port !== undefined;

  if (!isRepairMode) {
    return { help: false, regenCert: false, command };
  }

  return {
    help: false,
    regenCert: false,
    repair: {
      reset: wantsReset,
      password: wantsPassword,
      ...(port !== undefined ? { port } : {}),
    },
  };
};
