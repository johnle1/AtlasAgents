/**
 * Unit tests — server config/configManager keepAlive validation & normalization
 *
 * Category checklist:
 * - Normal: a well-formed duration string round-trips
 * - Boundary: "-1" (string) normalizes to -1 (number); the number -1 passes through
 * - Error: garbage strings/empty string are rejected by set() and repaired to
 *   the default on load
 *
 * @remarks
 * Ollama parses a string `keep_alive` with Go's `time.ParseDuration`, which
 * rejects a bare "-1" for having no unit — never-unload has to travel as the
 * JSON *number* -1. The type's own doc previously suggested the string form,
 * so a user following it would persist a value that 400s every subsequent
 * `/api/chat`/`/api/generate` call until the config was hand-edited.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ConfigManager } from "../../../../packages/server/src/config/index.js";
import {
  mergeConfig,
  normaliseKeepAlive,
} from "../../../../packages/server/src/config/parsing.js";
import { initializeCipher } from "@loopycode/shared";

describe("normaliseKeepAlive", () => {
  it("accepts a duration string with a unit (normal)", () => {
    expect(normaliseKeepAlive("30m")).toBe("30m");
    expect(normaliseKeepAlive("1h")).toBe("1h");
    expect(normaliseKeepAlive("90s")).toBe("90s");
    expect(normaliseKeepAlive("500ms")).toBe("500ms");
  });

  it("accepts a compound duration, matching Go's time.ParseDuration (regression guard)", () => {
    // time.ParseDuration accepts multiple <number><unit> segments
    // concatenated with no separator — a single-segment-only pattern would
    // reject every valid compound duration a user might reasonably type.
    expect(normaliseKeepAlive("1h30m")).toBe("1h30m");
    expect(normaliseKeepAlive("2h45m30s")).toBe("2h45m30s");
    expect(normaliseKeepAlive("1h30m500ms")).toBe("1h30m500ms");
  });

  it('normalizes the string "-1" to the number -1 (boundary)', () => {
    expect(normaliseKeepAlive("-1")).toBe(-1);
    expect(normaliseKeepAlive(" -1 ")).toBe(-1);
  });

  it("passes the number -1 through unchanged (boundary)", () => {
    expect(normaliseKeepAlive(-1)).toBe(-1);
  });

  it("accepts any other finite number as a second count", () => {
    expect(normaliseKeepAlive(1800)).toBe(1800);
  });

  it("rejects a unitless positive number literal string like Ollama would (error)", () => {
    // Only "-1" gets the special never-unload spelling; "5" as a bare
    // number-string still has no unit and Ollama's parser would reject it.
    expect(normaliseKeepAlive("5")).toBeNull();
  });

  it("rejects garbage strings (error)", () => {
    expect(normaliseKeepAlive("forever")).toBeNull();
    expect(normaliseKeepAlive("")).toBeNull();
    expect(normaliseKeepAlive("30")).toBeNull();
  });

  it("rejects non-finite numbers and non-string/non-number types (error)", () => {
    expect(normaliseKeepAlive(Infinity)).toBeNull();
    expect(normaliseKeepAlive(NaN)).toBeNull();
    expect(normaliseKeepAlive(null)).toBeNull();
    expect(normaliseKeepAlive(undefined)).toBeNull();
    expect(normaliseKeepAlive({})).toBeNull();
  });
});

describe("mergeConfig — keepAlive repair on load", () => {
  it('repairs a previously-persisted string "-1" to the number on load (regression guard)', () => {
    const cfg = mergeConfig({ keepAlive: "-1" });
    expect(cfg.keepAlive).toBe(-1);
  });

  it("falls back to the default for a garbage stored value", () => {
    const cfg = mergeConfig({ keepAlive: "not-a-duration" });
    expect(cfg.keepAlive).toBe("30m");
  });

  it("passes a well-formed stored duration through unchanged", () => {
    const cfg = mergeConfig({ keepAlive: "1h" });
    expect(cfg.keepAlive).toBe("1h");
  });
});

describe('ConfigManager.set("keepAlive", ...)', () => {
  // ConfigManager._saveRaw encrypts the whole stored config (not just the
  // `providers` field), so any set() that persists requires the cipher
  // unlocked first — normally done via unlockOrSetupProvidersCipher at
  // server startup. These tests exercise keepAlive validation, not
  // encryption, so unlock once with a fixed passphrase.
  beforeAll(() => {
    initializeCipher("test-passphrase-for-keepalive-tests");
  });

  const tempRoots: string[] = [];

  const makeManager = async (): Promise<{
    manager: ConfigManager;
    root: string;
  }> => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-keepalive-"));
    tempRoots.push(root);
    return { manager: new ConfigManager({ rootDir: root }), root };
  };

  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("persists a well-formed duration string (normal)", async () => {
    const { manager } = await makeManager();
    await manager.set("keepAlive", "45m");
    expect(await manager.getKeepAlive()).toBe("45m");
  });

  it('normalizes "-1" to the number -1 on write, not the rejected string form (regression guard)', async () => {
    const { manager } = await makeManager();
    await manager.set("keepAlive", "-1");
    const stored = await manager.getKeepAlive();
    expect(stored).toBe(-1);
    expect(typeof stored).toBe("number");
  });

  it("accepts the number -1 directly", async () => {
    const { manager } = await makeManager();
    await manager.set("keepAlive", -1);
    expect(await manager.getKeepAlive()).toBe(-1);
  });

  it("rejects a value Ollama's duration parser would reject (error)", async () => {
    const { manager } = await makeManager();
    await expect(manager.set("keepAlive", "banana")).rejects.toThrow();
    // A rejected set() must not have persisted anything.
    expect(await manager.getKeepAlive()).toBe("30m");
  });

  it("rejects an empty string (error)", async () => {
    const { manager } = await makeManager();
    await expect(manager.set("keepAlive", "")).rejects.toThrow();
  });
});
