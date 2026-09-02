/**
 * Unit tests — packages/client/src/config/parsing.ts
 */

import { describe, expect, it } from "vitest";
import {
  configNeedsPersist,
  mergeConfigFromDisk,
} from "../../../../packages/client/src/config/parsing.js";
import { DEFAULT_CONFIG } from "../../../../packages/client/src/config/types.js";

describe("mergeConfigFromDisk", () => {
  it("fills missing keys from DEFAULT_CONFIG", () => {
    const merged = mergeConfigFromDisk({});
    expect(merged.server).toBe(DEFAULT_CONFIG.server);
    expect(merged.port).toBe(DEFAULT_CONFIG.port);
    expect(merged.ui).toEqual(DEFAULT_CONFIG.ui);
  });

  it("overrides with parsed values", () => {
    const merged = mergeConfigFromDisk({ port: 9000, server: "remote" });
    expect(merged.port).toBe(9000);
    expect(merged.server).toBe("remote");
  });

  it("rejects invalid subagentCap and showThinkOutput", () => {
    const merged = mergeConfigFromDisk({
      subagentCap: 0,
      showThinkOutput: "yes" as unknown as boolean,
    });
    expect(merged.subagentCap).toBe(DEFAULT_CONFIG.subagentCap);
    expect(merged.showThinkOutput).toBe(DEFAULT_CONFIG.showThinkOutput);
  });

  it("rejects negative and non-integer subagentCap", () => {
    expect(mergeConfigFromDisk({ subagentCap: -5 }).subagentCap).toBe(DEFAULT_CONFIG.subagentCap);
    expect(mergeConfigFromDisk({ subagentCap: 3.14 }).subagentCap).toBe(DEFAULT_CONFIG.subagentCap);
    expect(mergeConfigFromDisk({ subagentCap: Number.NaN }).subagentCap).toBe(
      DEFAULT_CONFIG.subagentCap,
    );
  });

  it("accepts valid positive integer subagentCap", () => {
    expect(mergeConfigFromDisk({ subagentCap: 1 }).subagentCap).toBe(1);
    expect(mergeConfigFromDisk({ subagentCap: 8 }).subagentCap).toBe(8);
  });

  it("merges ui partially", () => {
    const merged = mergeConfigFromDisk({
      ui: { theme: "ocean" },
    });
    expect(merged.ui.theme).toBe("ocean");
    expect(merged.ui.showSpinner).toBe(DEFAULT_CONFIG.ui.showSpinner);
  });

  it("merges sandbox partially, keeping containerImage default", () => {
    const merged = mergeConfigFromDisk({
      sandbox: { mode: "container" } as never,
    });
    expect(merged.sandbox.mode).toBe("container");
    expect(merged.sandbox.containerImage).toBe(
      DEFAULT_CONFIG.sandbox.containerImage,
    );
  });

  it("rejects an invalid sandbox.mode and falls back to the default (error)", () => {
    const merged = mergeConfigFromDisk({
      sandbox: { mode: "yolo" } as never,
    });
    expect(merged.sandbox.mode).toBe(DEFAULT_CONFIG.sandbox.mode);
  });

  it("accepts a custom containerImage", () => {
    const merged = mergeConfigFromDisk({
      sandbox: { mode: "auto", containerImage: "my-org/my-sandbox:1.2" } as never,
    });
    expect(merged.sandbox.containerImage).toBe("my-org/my-sandbox:1.2");
  });

  it("persists default / accept_edits / plan and migrates auto_edit (normal)", () => {
    expect(
      mergeConfigFromDisk({ approvalMode: "accept_edits" }).approvalMode,
    ).toBe("accept_edits");
    expect(
      mergeConfigFromDisk({ approvalMode: "plan" }).approvalMode,
    ).toBe("plan");
    expect(
      mergeConfigFromDisk({
        approvalMode: "auto_edit" as unknown as "accept_edits",
      }).approvalMode,
    ).toBe("accept_edits");
  });

  it("drops auto (session-only full bypass), bypass, and unknown approvalMode (error)", () => {
    expect(
      mergeConfigFromDisk({
        approvalMode: "auto" as unknown as "default",
      }).approvalMode,
    ).toBe("default");
    expect(
      mergeConfigFromDisk({
        approvalMode: "bypass" as unknown as "default",
      }).approvalMode,
    ).toBe("default");
    expect(
      mergeConfigFromDisk({
        approvalMode: "nope" as unknown as "default",
      }).approvalMode,
    ).toBe("default");
  });
});

describe("configNeedsPersist", () => {
  it("returns false for a complete valid stored config", () => {
    const stored = { ...DEFAULT_CONFIG };
    expect(configNeedsPersist(stored, stored)).toBe(false);
  });

  it("returns true when a top-level key is missing", () => {
    const stored = { ...DEFAULT_CONFIG };
    delete (stored as Record<string, unknown>).retries;
    expect(configNeedsPersist(stored as Record<string, unknown>, {})).toBe(
      true,
    );
  });

  it("returns true when ui is missing or incomplete", () => {
    expect(
      configNeedsPersist({ ...DEFAULT_CONFIG, ui: null }, {}),
    ).toBe(true);
    expect(
      configNeedsPersist(
        { ...DEFAULT_CONFIG, ui: { theme: "default" } },
        {},
      ),
    ).toBe(true);
  });

  it("returns true when sandbox is missing or incomplete (upgrade path for pre-sandbox config files)", () => {
    const withoutSandbox = { ...DEFAULT_CONFIG } as Record<string, unknown>;
    delete withoutSandbox.sandbox;
    expect(configNeedsPersist(withoutSandbox, {})).toBe(true);
    expect(
      configNeedsPersist({ ...DEFAULT_CONFIG, sandbox: { mode: "auto" } }, {}),
    ).toBe(true);
  });

  it("returns true for invalid subagentCap or showThinkOutput in parsed", () => {
    expect(
      configNeedsPersist(
        { ...DEFAULT_CONFIG },
        { subagentCap: 0 },
      ),
    ).toBe(true);
    expect(
      configNeedsPersist(
        { ...DEFAULT_CONFIG },
        { showThinkOutput: "nope" as unknown as boolean },
      ),
    ).toBe(true);
  });
});
