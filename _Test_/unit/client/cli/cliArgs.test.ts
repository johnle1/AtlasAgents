/**
 * Unit tests — client cliArgs.ts: the split between session-only overrides
 * (`--host`/`--server`/`--port`) and config-repair mode
 * (`--reset`/`--password`/`--address`/`--trust-fingerprint`).
 *
 * @remarks
 * The mode split is the load-bearing behaviour here. Config-repair mode is the
 * only way to change connection settings while the client cannot reach the
 * server, so it must trigger on exactly the intended flags — and, just as
 * importantly, must *not* trigger on the pre-existing session flags, which
 * would silently turn a one-off `loopycode --host x` into a permanent change.
 *
 * `parseCliArgs` takes a full argv, so every case prefixes the two entries
 * Node supplies (`node` and the script path) that the parser slices off.
 */

import { describe, expect, it, vi } from "vitest";
import {
  applyCliOverrides,
  parseCliArgs,
  printCliHelp,
} from "../../../../packages/client/src/cli/cliArgs.js";
import type { Config } from "../../../../packages/client/src/config/index.js";

/** Builds an argv the way Node presents it, so tests read as typed commands. */
const argv = (...args: string[]): string[] => ["node", "loopycode", ...args];

describe("parseCliArgs — session override mode (unchanged behaviour)", () => {
  it("keeps --host and --port as session overrides without entering repair mode", () => {
    const result = parseCliArgs(argv("--host", "10.0.0.7", "--port", "8001"));
    expect(result.repair).toBeUndefined();
    expect(result.overrides).toEqual({ server: "10.0.0.7", port: 8001 });
  });

  it("does not enter repair mode for --port alone", () => {
    const result = parseCliArgs(argv("--port", "8001"));
    expect(result.repair).toBeUndefined();
    expect(result.overrides).toEqual({ port: 8001 });
  });

  it("treats --server as an alias of --host", () => {
    expect(parseCliArgs(argv("--server", "example.com")).overrides).toEqual(
      parseCliArgs(argv("--host", "example.com")).overrides,
    );
  });

  it("accepts the short forms -H and -p", () => {
    const result = parseCliArgs(argv("-H", "10.0.0.7", "-p", "8001"));
    expect(result.overrides).toEqual({ server: "10.0.0.7", port: 8001 });
  });

  it("accepts the positional 'start' without producing overrides", () => {
    const result = parseCliArgs(argv("start"));
    expect(result.repair).toBeUndefined();
    expect(result.overrides).toEqual({});
  });

  it("short-circuits on --help before anything else is parsed", () => {
    const result = parseCliArgs(argv("--help", "--reset", "--port", "not-a-port"));
    expect(result).toEqual({ help: true, overrides: {} });
  });
});

describe("parseCliArgs — config-repair mode", () => {
  it("enters repair mode on --reset", () => {
    const result = parseCliArgs(argv("--reset"));
    expect(result.repair).toEqual({
      reset: true,
      password: false,
      trustFingerprint: false,
    });
  });

  it("enters repair mode on --password", () => {
    const result = parseCliArgs(argv("--password"));
    expect(result.repair).toEqual({
      reset: false,
      password: true,
      trustFingerprint: false,
    });
  });

  it("enters repair mode on --address and persists the host", () => {
    const result = parseCliArgs(argv("--address", "10.0.0.7"));
    expect(result.repair).toEqual({
      reset: false,
      password: false,
      trustFingerprint: false,
      server: "10.0.0.7",
    });
  });

  it("enters repair mode on the --address=host form", () => {
    const result = parseCliArgs(argv("--address=10.0.0.7"));
    expect(result.repair?.server).toBe("10.0.0.7");
  });

  it("enters repair mode on the short -a form", () => {
    expect(parseCliArgs(argv("-a", "10.0.0.7")).repair?.server).toBe("10.0.0.7");
  });

  it("folds --port into the repair request instead of the session overrides", () => {
    const result = parseCliArgs(argv("--address", "10.0.0.7", "--port", "8001"));
    expect(result.repair?.port).toBe(8001);
    expect(result.overrides).toEqual({});
  });

  it("collects every setting from a combined reset-and-repoint command", () => {
    const result = parseCliArgs(
      argv("--reset", "--address", "10.0.0.7", "--port", "8001", "--password"),
    );
    expect(result.repair).toEqual({
      reset: true,
      password: true,
      trustFingerprint: false,
      server: "10.0.0.7",
      port: 8001,
    });
  });

  it("enters repair mode on --trust-fingerprint", () => {
    const result = parseCliArgs(argv("--trust-fingerprint"));
    expect(result.repair).toEqual({
      reset: false,
      password: false,
      trustFingerprint: true,
    });
  });

  it("combines --trust-fingerprint with --address and --port in one command", () => {
    const result = parseCliArgs(
      argv("--trust-fingerprint", "--address", "10.0.0.7", "--port", "8001"),
    );
    expect(result.repair).toEqual({
      reset: false,
      password: false,
      trustFingerprint: true,
      server: "10.0.0.7",
      port: 8001,
    });
  });

  it("leaves trustFingerprint false when the flag is absent", () => {
    expect(parseCliArgs(argv("--reset")).repair?.trustFingerprint).toBe(false);
  });

  it("accepts --host as an address alias once already in repair mode", () => {
    const result = parseCliArgs(argv("--reset", "--host", "10.0.0.7"));
    expect(result.repair?.server).toBe("10.0.0.7");
  });

  it("prefers --address over --host when both are given", () => {
    const result = parseCliArgs(
      argv("--address", "10.0.0.7", "--host", "192.168.1.5"),
    );
    expect(result.repair?.server).toBe("10.0.0.7");
  });

  it("leaves overrides empty in repair mode so nothing tries to connect", () => {
    expect(parseCliArgs(argv("--reset", "--port", "8001")).overrides).toEqual({});
  });
});

describe("parseCliArgs — validation", () => {
  it.each(["0", "65536", "abc", "-1"])(
    "rejects the invalid port %s",
    (port) => {
      expect(() => parseCliArgs(argv("--port", port))).toThrow(/invalid --port/i);
    },
  );

  it("rejects an invalid port in repair mode too", () => {
    expect(() => parseCliArgs(argv("--reset", "--port", "99999"))).toThrow(
      /invalid --port/i,
    );
  });

  it.each(["1", "65535"])("accepts the boundary port %s", (port) => {
    expect(parseCliArgs(argv("--port", port)).overrides.port).toBe(Number(port));
  });

  it("rejects an inline --password value so it is not silently discarded", () => {
    expect(() => parseCliArgs(argv("--password", "hunter2"))).toThrow(
      /--password takes no value/i,
    );
  });

  it("still allows the 'start' positional after --password", () => {
    expect(parseCliArgs(argv("--password", "start")).repair?.password).toBe(true);
  });

  it("rejects an empty --address", () => {
    expect(() => parseCliArgs(argv("--address", ""))).toThrow(/invalid --address/i);
  });

  it("rejects --address with no value at all", () => {
    expect(() => parseCliArgs(argv("--address"))).toThrow(/invalid --address/i);
  });

  it("rejects --address that swallowed the following flag as its value", () => {
    expect(() => parseCliArgs(argv("--address", "--reset"))).toThrow(
      /invalid --address/i,
    );
  });
});

describe("applyCliOverrides", () => {
  const baseConfig = { server: "localhost", port: 7000 } as Config;

  it("applies only the fields present in the overrides", () => {
    expect(applyCliOverrides(baseConfig, { port: 8001 })).toEqual({
      server: "localhost",
      port: 8001,
    });
  });

  it("does not mutate the config it was given", () => {
    applyCliOverrides(baseConfig, { server: "10.0.0.7", port: 8001 });
    expect(baseConfig).toEqual({ server: "localhost", port: 7000 });
  });
});

describe("printCliHelp", () => {
  it("prints usage text to stdout", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printCliHelp();
    expect(spy).toHaveBeenCalled();
    const joined = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toMatch(/Usage: loopycode/i);
    spy.mockRestore();
  });
});
