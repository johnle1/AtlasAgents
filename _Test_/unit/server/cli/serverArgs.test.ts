/**
 * Unit tests — server cli/serverArgs.ts: parseServerArgs's start/regen-cert/
 * help/repair-mode detection, and its --port/--password value guards.
 */

import { describe, expect, it } from "vitest";
import { isServerLaunchCommand, parseServerArgs } from "../../../../packages/server/src/cli/serverArgs.js";

const argv = (...flags: string[]): string[] => [
  "node",
  "atlas-server",
  ...flags,
];

describe("parseServerArgs — start / help / regen-cert", () => {
  it("no args: plain start, no repair, no command", () => {
    const result = parseServerArgs(argv());
    expect(result).toEqual({ help: false, regenCert: false, command: undefined });
  });

  it("'run' positional: no repair", () => {
    const result = parseServerArgs(argv("run"));
    expect(result.repair).toBeUndefined();
    expect(result.command).toBe("run");
  });

  it("an unrecognized positional is passed through as `command`, not rejected here", () => {
    const result = parseServerArgs(argv("bogus"));
    expect(result.help).toBe(false);
    expect(result.regenCert).toBe(false);
    expect(result.repair).toBeUndefined();
    expect(result.command).toBe("bogus");
  });

  it("--help / -h / 'help' all set help:true", () => {
    expect(parseServerArgs(argv("--help")).help).toBe(true);
    expect(parseServerArgs(argv("-h")).help).toBe(true);
    expect(parseServerArgs(argv("help")).help).toBe(true);
  });

  it("--regen-cert sets regenCert:true and skips repair detection", () => {
    const result = parseServerArgs(argv("--regen-cert"));
    expect(result.regenCert).toBe(true);
    expect(result.repair).toBeUndefined();
  });
});

describe("parseServerArgs — repair mode: --reset", () => {
  it("--reset alone", () => {
    const result = parseServerArgs(argv("--reset"));
    expect(result.repair).toEqual({ reset: true, password: false });
  });
});

describe("parseServerArgs — repair mode: --password", () => {
  it("--password alone", () => {
    const result = parseServerArgs(argv("--password"));
    expect(result.repair).toEqual({ reset: false, password: true });
  });

  it("--password <value> throws rather than silently discarding the value", () => {
    expect(() => parseServerArgs(argv("--password", "hunter2"))).toThrow(
      /takes no value/i,
    );
  });

  it("--password start is fine — 'start' is not read as an inline value", () => {
    const result = parseServerArgs(argv("--password", "start"));
    expect(result.repair).toEqual({ reset: false, password: true });
  });

  it("--password run is fine — 'run' is not read as an inline value", () => {
    const result = parseServerArgs(argv("--password", "run"));
    expect(result.repair).toEqual({ reset: false, password: true });
  });

  it("--password followed by another flag is fine (not an inline value)", () => {
    const result = parseServerArgs(argv("--password", "--reset"));
    expect(result.repair).toEqual({ reset: true, password: true });
  });
});

describe("parseServerArgs — repair mode: --port", () => {
  it("--port <n> saves a validated port number", () => {
    const result = parseServerArgs(argv("--port", "8001"));
    expect(result.repair).toEqual({ reset: false, password: false, port: 8001 });
  });

  it("bare --port (no value) requests the interactive port prompt", () => {
    const result = parseServerArgs(argv("--port"));
    expect(result.repair).toEqual({
      reset: false,
      password: false,
      port: "prompt",
    });
  });

  it("--port immediately followed by another flag throws rather than swallowing it as the port value", () => {
    // node:util's parseArgs (non-strict) greedily takes the next token as a
    // string option's value regardless of its shape — so `--port --reset`
    // parses to port:"--reset" and --reset is never recognized at all. The
    // startsWith("-") guard turns that into a loud error instead of either
    // silently dropping --reset or saving the literal string "--reset" as a
    // port number.
    expect(() => parseServerArgs(argv("--port", "--reset"))).toThrow(
      /invalid --port.*looks like another flag/i,
    );
  });

  it("--port abc throws (not a number)", () => {
    expect(() => parseServerArgs(argv("--port", "abc"))).toThrow(
      /invalid --port/i,
    );
  });

  it("--port 0 and --port 70000 throw (out of 1-65535 range)", () => {
    expect(() => parseServerArgs(argv("--port", "0"))).toThrow(/invalid --port/i);
    expect(() => parseServerArgs(argv("--port", "70000"))).toThrow(
      /invalid --port/i,
    );
  });

  it("--port 65535 and --port 1 are valid boundary values", () => {
    expect(parseServerArgs(argv("--port", "65535")).repair?.port).toBe(65535);
    expect(parseServerArgs(argv("--port", "1")).repair?.port).toBe(1);
  });
});

describe("parseServerArgs — combined repair flags", () => {
  it("--reset --port 8001", () => {
    const result = parseServerArgs(argv("--reset", "--port", "8001"));
    expect(result.repair).toEqual({ reset: true, password: false, port: 8001 });
  });

  it("--reset --password --port 8001", () => {
    const result = parseServerArgs(
      argv("--reset", "--password", "--port", "8001"),
    );
    expect(result.repair).toEqual({ reset: true, password: true, port: 8001 });
  });
});

describe("isServerLaunchCommand", () => {
  it("accepts a missing command, start, and run", () => {
    expect(isServerLaunchCommand(undefined)).toBe(true);
    expect(isServerLaunchCommand("")).toBe(true);
    expect(isServerLaunchCommand("start")).toBe(true);
    expect(isServerLaunchCommand("run")).toBe(true);
  });

  it("rejects any other positional", () => {
    expect(isServerLaunchCommand("bogus")).toBe(false);
    expect(isServerLaunchCommand("help")).toBe(false);
  });
});
