/**
 * Unit tests — server config/configManager numParallel/flashAttention/
 * kvCacheType validation & normalization
 *
 * Category checklist:
 * - Normal: each field round-trips through set()/getX()
 * - Boundary: unset means "auto-detect", not a concrete default — unlike
 *   `effort`/`keepAlive`, these three deliberately have NO `SERVER_DEFAULTS`
 *   entry (same pattern as `numCtx`, see `keepAlive.test.ts`/`effort.test.ts`
 *   for the sibling fields that DO have one)
 * - Error: a garbage value is rejected by set() and repaired to `undefined`
 *   on load
 *
 * @remarks
 * These three feed `ollama/runtimeTuning.ts`'s `resolveOllamaTuning`, which
 * only applies them when this process itself spawns `ollama serve` — see
 * `ollamaLifecycle.test.ts` for that half of the contract.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ConfigManager } from "../../../../packages/server/src/config/index.js";
import {
  mergeConfig,
  normaliseKvCacheType,
} from "../../../../packages/server/src/config/parsing.js";
import { initializeCipher } from "@atlasagents/shared";

describe("normaliseKvCacheType", () => {
  it("accepts each of the three recognized kv cache types (normal)", () => {
    expect(normaliseKvCacheType("f16")).toBe("f16");
    expect(normaliseKvCacheType("q8_0")).toBe("q8_0");
    expect(normaliseKvCacheType("q4_0")).toBe("q4_0");
  });

  it("rejects a garbage string (error)", () => {
    expect(normaliseKvCacheType("q16_bit")).toBeNull();
    expect(normaliseKvCacheType("")).toBeNull();
    expect(normaliseKvCacheType("Q8_0")).toBeNull(); // case-sensitive
  });

  it("rejects non-string types (error)", () => {
    expect(normaliseKvCacheType(1)).toBeNull();
    expect(normaliseKvCacheType(null)).toBeNull();
    expect(normaliseKvCacheType(undefined)).toBeNull();
    expect(normaliseKvCacheType({})).toBeNull();
  });
});

describe("mergeConfig — numParallel/flashAttention/kvCacheType repair on load", () => {
  it("all three are undefined when unset — auto-detect, not a guessed default (boundary)", () => {
    const cfg = mergeConfig({});
    expect(cfg.numParallel).toBeUndefined();
    expect(cfg.flashAttention).toBeUndefined();
    expect(cfg.kvCacheType).toBeUndefined();
  });

  it("repairs a garbage numParallel to undefined rather than surviving as-is (error)", () => {
    expect(mergeConfig({ numParallel: -5 }).numParallel).toBeUndefined();
    expect(mergeConfig({ numParallel: 2.5 }).numParallel).toBeUndefined();
    expect(mergeConfig({ numParallel: "4" }).numParallel).toBeUndefined();
  });

  it("repairs a garbage kvCacheType to undefined rather than surviving as-is (error)", () => {
    expect(mergeConfig({ kvCacheType: "not-a-type" }).kvCacheType).toBeUndefined();
  });

  it("a non-boolean flashAttention is repaired to undefined (error)", () => {
    expect(mergeConfig({ flashAttention: "yes" }).flashAttention).toBeUndefined();
  });

  it("passes well-formed stored values through unchanged (normal)", () => {
    const cfg = mergeConfig({
      numParallel: 6,
      flashAttention: false,
      kvCacheType: "f16",
    });
    expect(cfg.numParallel).toBe(6);
    expect(cfg.flashAttention).toBe(false);
    expect(cfg.kvCacheType).toBe("f16");
  });
});

describe('ConfigManager.set("numParallel"/"flashAttention"/"kvCacheType", ...)', () => {
  beforeAll(() => {
    initializeCipher("test-passphrase-for-runtime-tuning-tests");
  });

  const tempRoots: string[] = [];

  const makeManager = async (): Promise<{
    manager: ConfigManager;
    root: string;
  }> => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-runtime-tuning-"));
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

  it("all three are undefined before any set() (normal)", async () => {
    const { manager } = await makeManager();
    expect(await manager.getNumParallel()).toBeUndefined();
    expect(await manager.getFlashAttention()).toBeUndefined();
    expect(await manager.getKvCacheType()).toBeUndefined();
  });

  it("persists numParallel as a positive integer (normal)", async () => {
    const { manager } = await makeManager();
    await manager.set("numParallel", 4);
    expect(await manager.getNumParallel()).toBe(4);
  });

  it("rejects a non-positive-integer numParallel (error)", async () => {
    const { manager } = await makeManager();
    await expect(manager.set("numParallel", 0)).rejects.toThrow();
    await expect(manager.set("numParallel", -1)).rejects.toThrow();
    await expect(manager.set("numParallel", 2.5)).rejects.toThrow();
    expect(await manager.getNumParallel()).toBeUndefined();
  });

  it("persists flashAttention as a boolean, including false (normal — false must not be treated as unset)", async () => {
    const { manager } = await makeManager();
    await manager.set("flashAttention", false);
    expect(await manager.getFlashAttention()).toBe(false);
    await manager.set("flashAttention", true);
    expect(await manager.getFlashAttention()).toBe(true);
  });

  it("rejects a non-boolean flashAttention (error)", async () => {
    const { manager } = await makeManager();
    await expect(manager.set("flashAttention", "yes")).rejects.toThrow();
  });

  it("persists each recognized kvCacheType (normal)", async () => {
    const { manager } = await makeManager();
    for (const type of ["f16", "q8_0", "q4_0"] as const) {
      await manager.set("kvCacheType", type);
      expect(await manager.getKvCacheType()).toBe(type);
    }
  });

  it("rejects a garbage kvCacheType (error)", async () => {
    const { manager } = await makeManager();
    await expect(manager.set("kvCacheType", "ludicrous")).rejects.toThrow();
    expect(await manager.getKvCacheType()).toBeUndefined();
  });
});
