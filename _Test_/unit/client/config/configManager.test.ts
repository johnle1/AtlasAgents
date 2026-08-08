/**
 * Unit tests — client config/manager helpers (no encrypted save path).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("config/manager", () => {
  let tmp: string;
  let configFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loopy-cfg-mgr-"));
    configFile = path.join(tmp, "config.json");
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("exports hasConfigFile / getDefaultConfig / ensureDirs / isConnectionConfigured", async () => {
    // CONFIG_DIR points at a subdirectory that does not exist yet — mkdtempSync
    // only creates `tmp` itself — so ensureDirs() has something real to do,
    // and asserting on it afterward actually exercises directory creation
    // instead of restating that `tmp` (which already existed) still exists.
    const configDir = path.join(tmp, "nested");
    vi.doMock("../../../../packages/client/src/config/types.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../../../packages/client/src/config/types.js")
      >("../../../../packages/client/src/config/types.js");
      return {
        ...actual,
        CONFIG_DIR: configDir,
        CONFIG_FILE: configFile,
      };
    });

    const mgr = await import("../../../../packages/client/src/config/manager.js");
    expect(typeof mgr.hasConfigFile).toBe("function");
    expect(typeof mgr.loadConfig).toBe("function");
    expect(typeof mgr.saveConfig).toBe("function");
    expect(typeof mgr.updateConfig).toBe("function");
    expect(mgr.hasConfigFile()).toBe(false);
    const defaults = mgr.getDefaultConfig();
    expect(defaults).toBeTypeOf("object");
    expect(fs.existsSync(configDir)).toBe(false);
    mgr.ensureDirs();
    expect(fs.statSync(configDir).isDirectory()).toBe(true);
    expect(mgr.isConnectionConfigured(defaults)).toBeTypeOf("boolean");
  });
});
