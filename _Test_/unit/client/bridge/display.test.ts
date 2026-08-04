/**
 * Unit tests — ui/bridge/display.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../../../packages/client/src/config/index.js";
import {
  setBridgeHooks,
  setTaskActiveValue,
} from "../../../../packages/client/src/ui/bridge/state.js";
import {
  enterAlternateScreen,
  exitAlternateScreen,
  getTaskActive,
  isTaskActive,
  refreshInkBanner,
  setBusy,
  setCwdLabel,
  setTaskActive,
} from "../../../../packages/client/src/ui/bridge/display.js";

beforeEach(() => {
  setBridgeHooks({});
  setTaskActiveValue(false);
});

describe("display bridge", () => {
  it("setBusy invokes onBusy hook", () => {
    const onBusy = vi.fn();
    setBridgeHooks({ onBusy });
    setBusy(true);
    expect(onBusy).toHaveBeenCalledWith(true);
  });

  it("setTaskActive updates value and invokes onTaskActive", () => {
    const onTaskActive = vi.fn();
    setBridgeHooks({ onTaskActive });
    setTaskActive(true);
    expect(getTaskActive()).toBe(true);
    expect(isTaskActive()).toBe(true);
    expect(onTaskActive).toHaveBeenCalledWith(true);
  });

  it("setCwdLabel invokes onCwd", () => {
    const onCwd = vi.fn();
    setBridgeHooks({ onCwd });
    setCwdLabel("/workspace");
    expect(onCwd).toHaveBeenCalledWith("/workspace");
  });

  it("refreshInkBanner invokes onBannerRefresh", () => {
    const onBannerRefresh = vi.fn();
    const configuration = { server: "localhost" } as Config;
    setBridgeHooks({ onBannerRefresh });
    refreshInkBanner(configuration);
    expect(onBannerRefresh).toHaveBeenCalledWith(configuration);
  });

  it("enterAlternateScreen / exitAlternateScreen no-op when stdout is not a TTY", () => {
    const write = vi.spyOn(process.stdout, "write");
    enterAlternateScreen();
    exitAlternateScreen();
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});
