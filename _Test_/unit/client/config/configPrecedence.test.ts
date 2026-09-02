/**
 * Unit tests — Config Precedence Order: CLI Flags > Disk Config > Default Config.
 *
 * Verifies that the configuration layers compose deterministically:
 * 1. Base defaults are always present (DEFAULT_CONFIG)
 * 2. Disk settings override defaults when valid
 * 3. CLI runtime arguments override disk settings for the current session
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../../../packages/client/src/config/types.js";
import { mergeConfigFromDisk } from "../../../../packages/client/src/config/parsing.js";
import { applyCliOverrides, parseCliArgs } from "../../../../packages/client/src/cli/cliArgs.js";

const argv = (...args: string[]): string[] => ["node", "atlas", ...args];

describe("Config Precedence Hierarchy", () => {
  it("applies DEFAULT_CONFIG when disk config and CLI flags are empty", () => {
    const fromDisk = mergeConfigFromDisk({});
    const cliResult = parseCliArgs(argv());
    const finalConfig = applyCliOverrides(fromDisk, cliResult.overrides);

    expect(finalConfig.server).toBe(DEFAULT_CONFIG.server);
    expect(finalConfig.port).toBe(DEFAULT_CONFIG.port);
    expect(finalConfig.approvalMode).toBe(DEFAULT_CONFIG.approvalMode);
    expect(finalConfig.ui.theme).toBe(DEFAULT_CONFIG.ui.theme);
  });

  it("disk config overrides DEFAULT_CONFIG", () => {
    const diskConfig = {
      server: "192.168.1.100",
      port: 8080,
      approvalMode: "accept_edits" as const,
      ui: { theme: "cyberpunk" },
    };

    const fromDisk = mergeConfigFromDisk(diskConfig);
    const cliResult = parseCliArgs(argv());
    const finalConfig = applyCliOverrides(fromDisk, cliResult.overrides);

    expect(finalConfig.server).toBe("192.168.1.100");
    expect(finalConfig.port).toBe(8080);
    expect(finalConfig.approvalMode).toBe("accept_edits");
    expect(finalConfig.ui.theme).toBe("cyberpunk");
    // Non-overridden nested UI defaults should still be present
    expect(finalConfig.ui.showSpinner).toBe(DEFAULT_CONFIG.ui.showSpinner);
  });

  it("CLI flags override disk config and DEFAULT_CONFIG", () => {
    const diskConfig = {
      server: "192.168.1.100",
      port: 8080,
    };

    const fromDisk = mergeConfigFromDisk(diskConfig);
    const cliResult = parseCliArgs(argv("--host", "override.internal", "--port", "9999"));
    const finalConfig = applyCliOverrides(fromDisk, cliResult.overrides);

    expect(finalConfig.server).toBe("override.internal");
    expect(finalConfig.port).toBe(9999);
  });

  it("CLI flags selectively override single fields without clobbering other disk settings", () => {
    const diskConfig = {
      server: "custom-host.lan",
      port: 7500,
      approvalMode: "accept_edits" as const,
    };

    const fromDisk = mergeConfigFromDisk(diskConfig);
    // Override only the port
    const cliResult = parseCliArgs(argv("-p", "9000"));
    const finalConfig = applyCliOverrides(fromDisk, cliResult.overrides);

    expect(finalConfig.server).toBe("custom-host.lan"); // Kept from disk
    expect(finalConfig.port).toBe(9000); // Overridden by CLI
    expect(finalConfig.approvalMode).toBe("accept_edits"); // Kept from disk
  });

  it("coerces a persisted session-only auto (old full-bypass) to default on load, CLI untouched", () => {
    const diskConfig = {
      approvalMode: "auto" as unknown as "default",
    };

    const fromDisk = mergeConfigFromDisk(diskConfig);
    const cliResult = parseCliArgs(argv());
    const finalConfig = applyCliOverrides(fromDisk, cliResult.overrides);

    expect(finalConfig.approvalMode).toBe("default");
  });
});
