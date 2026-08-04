/**
 * Unit tests — themeManager (mocked config + bridge).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn(() => ({ ui: { theme: "default" } }));
const updateConfig = vi.fn();
const refreshInkBanner = vi.fn();

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => loadConfig(),
  updateConfig: (...args: unknown[]) => updateConfig(...args),
}));

vi.mock("../../../../packages/client/src/ui/uiBridge.js", () => ({
  refreshInkBanner: () => refreshInkBanner(),
}));

import { THEMES } from "../../../../packages/client/src/theme/themes.js";
import {
  getTheme,
  getThemeKey,
  loadTheme,
  setTheme,
} from "../../../../packages/client/src/theme/themeManager.js";

describe("themeManager", () => {
  beforeEach(() => {
    loadConfig.mockReturnValue({ ui: { theme: "default" } });
    updateConfig.mockClear();
    refreshInkBanner.mockClear();
    loadTheme();
  });

  it("loadTheme / getTheme / getThemeKey expose the active theme", () => {
    expect(getThemeKey()).toBe("default");
    expect(getTheme()).toBeTypeOf("object");
    expect(getTheme()).toHaveProperty("reset");
  });

  it("setTheme switches the active key when the theme exists", () => {
    const alternate = Object.keys(THEMES).find((k) => k !== "default") ?? "default";
    setTheme(alternate);
    expect(getThemeKey()).toBe(alternate);
    expect(updateConfig).toHaveBeenCalled();
    expect(refreshInkBanner).toHaveBeenCalled();
  });
});
