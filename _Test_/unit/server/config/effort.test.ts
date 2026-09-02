/**
 * Unit tests — server config/configManager effort validation & normalization
 *
 * Category checklist:
 * - Normal: each of the five recognized effort literals round-trips
 * - Boundary: a value hand-edited onto disk before this field existed
 *   repairs to the default on load
 * - Error: a garbage string is rejected by set() and repaired to the
 *   default on load
 *
 * @remarks
 * `effort` controls how much the REASON phase (`orchestration/agent/
 * reasoner.ts`) re-deliberates before acting — see `EFFORT_LEVELS`'s doc
 * comment in `config/types.ts`. It follows the exact validate/normalize/
 * repair-on-load shape `keepAlive` already uses (see `keepAlive.test.ts`).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ConfigManager } from "../../../../packages/server/src/config/index.js";
import {
  mergeConfig,
  normaliseEffort,
} from "../../../../packages/server/src/config/parsing.js";
import { initializeCipher } from "@atlasagents/shared";

describe("normaliseEffort", () => {
  it("accepts each of the five recognized effort literals (normal)", () => {
    expect(normaliseEffort("low")).toBe("low");
    expect(normaliseEffort("medium")).toBe("medium");
    expect(normaliseEffort("high")).toBe("high");
    expect(normaliseEffort("extra-high")).toBe("extra-high");
    expect(normaliseEffort("max")).toBe("max");
  });

  it("rejects a garbage string (error)", () => {
    expect(normaliseEffort("ultra")).toBeNull();
    expect(normaliseEffort("")).toBeNull();
    expect(normaliseEffort("HIGH")).toBeNull(); // case-sensitive, unlike keepAlive
  });

  it("rejects non-string types (error)", () => {
    expect(normaliseEffort(1)).toBeNull();
    expect(normaliseEffort(null)).toBeNull();
    expect(normaliseEffort(undefined)).toBeNull();
    expect(normaliseEffort({})).toBeNull();
  });
});

describe("mergeConfig — effort repair on load", () => {
  it("falls back to the default for a garbage stored value (boundary — predates this field)", () => {
    const cfg = mergeConfig({ effort: "ludicrous" });
    expect(cfg.effort).toBe("medium");
  });

  it("falls back to the default when unset", () => {
    const cfg = mergeConfig({});
    expect(cfg.effort).toBe("medium");
  });

  it("passes a well-formed stored level through unchanged", () => {
    const cfg = mergeConfig({ effort: "max" });
    expect(cfg.effort).toBe("max");
  });
});

describe('ConfigManager.set("effort", ...)', () => {
  // Same encrypted-write requirement as keepAlive.test.ts — set() persists
  // the whole config, which requires the cipher unlocked first.
  beforeAll(() => {
    initializeCipher("test-passphrase-for-effort-tests");
  });

  const tempRoots: string[] = [];

  const makeManager = async (): Promise<{
    manager: ConfigManager;
    root: string;
  }> => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-effort-"));
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

  it("defaults to medium before any set() (normal)", async () => {
    const { manager } = await makeManager();
    expect(await manager.getEffort()).toBe("medium");
  });

  it("persists each recognized level (normal)", async () => {
    const { manager } = await makeManager();
    for (const level of ["low", "medium", "high", "extra-high", "max"] as const) {
      await manager.set("effort", level);
      expect(await manager.getEffort()).toBe(level);
    }
  });

  it("rejects a garbage value (error)", async () => {
    const { manager } = await makeManager();
    await expect(manager.set("effort", "ludicrous")).rejects.toThrow();
    // A rejected set() must not have persisted anything.
    expect(await manager.getEffort()).toBe("medium");
  });
});
