/**
 * Unit tests — client commands/sandboxHandlers.ts (`/sandbox`).
 *
 * Category checklist:
 * - Normal: status reports mode + resolved backend; a valid mode persists
 *   and resets the resolution cache
 * - Boundary: "off" mode reports without an "active backend" line;
 *   container image is only reported when relevant
 * - Error: an invalid mode token is rejected without touching config
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadConfig, mockUpdateConfig, mockResolveConfiguredSandbox, mockResetSandboxCache } =
  vi.hoisted(() => ({
    mockLoadConfig: vi.fn(),
    mockUpdateConfig: vi.fn(),
    mockResolveConfiguredSandbox: vi.fn(),
    mockResetSandboxCache: vi.fn(),
  }));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: mockLoadConfig,
  updateConfig: mockUpdateConfig,
}));

vi.mock("../../../../packages/client/src/fileProxy/sandbox/index.js", () => ({
  resolveConfiguredSandbox: mockResolveConfiguredSandbox,
  resetSandboxCache: mockResetSandboxCache,
}));

const printedLines: string[] = [];
const printedErrors: string[] = [];
const printedSuccess: string[] = [];

vi.mock("../../../../packages/client/src/renderer.js", () => ({
  printLine: (text: string) => printedLines.push(text),
  printError: (text: string) => printedErrors.push(text),
  printSuccessOp: (text: string) => printedSuccess.push(text),
}));

import { handleSandbox } from "../../../../packages/client/src/commands/sandboxHandlers.js";

beforeEach(() => {
  vi.clearAllMocks();
  printedLines.length = 0;
  printedErrors.length = 0;
  printedSuccess.length = 0;
  mockLoadConfig.mockReturnValue({
    sandbox: { mode: "auto", containerImage: "atlas-sandbox:latest" },
  });
});

describe("handleSandbox — status", () => {
  it("reports mode and active backend when one resolves (normal)", () => {
    mockResolveConfiguredSandbox.mockReturnValue({ id: "seatbelt" });
    handleSandbox("");
    expect(printedLines.some((l) => l.includes("auto"))).toBe(true);
    expect(printedLines.some((l) => l.includes("seatbelt"))).toBe(true);
  });

  it("treats bare '' and 'status' identically", () => {
    mockResolveConfiguredSandbox.mockReturnValue(null);
    handleSandbox("");
    const fromEmpty = [...printedLines];
    printedLines.length = 0;
    handleSandbox("status");
    expect(printedLines).toEqual(fromEmpty);
  });

  it("reports no backend available when resolution fails (boundary)", () => {
    mockResolveConfiguredSandbox.mockReturnValue(null);
    handleSandbox("");
    expect(printedLines.some((l) => l.includes("none available"))).toBe(true);
  });

  it("does not print an active-backend line when mode is off (boundary)", () => {
    mockLoadConfig.mockReturnValue({
      sandbox: { mode: "off", containerImage: "atlas-sandbox:latest" },
    });
    mockResolveConfiguredSandbox.mockReturnValue(null);
    handleSandbox("");
    expect(printedLines.some((l) => l.includes("Active backend"))).toBe(false);
  });

  it("reports the container image only when relevant (boundary)", () => {
    mockLoadConfig.mockReturnValue({
      sandbox: { mode: "container", containerImage: "my-org/img:1" },
    });
    mockResolveConfiguredSandbox.mockReturnValue({ id: "container-docker" });
    handleSandbox("");
    expect(printedLines.some((l) => l.includes("my-org/img:1"))).toBe(true);
  });
});

describe("handleSandbox — mode changes", () => {
  it("persists a valid mode and resets the sandbox cache (normal)", () => {
    handleSandbox("container");
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      sandbox: { mode: "container", containerImage: "atlas-sandbox:latest" },
    });
    expect(mockResetSandboxCache).toHaveBeenCalled();
    expect(printedSuccess.length).toBe(1);
  });

  it("accepts mode tokens case-insensitively", () => {
    handleSandbox("OFF");
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      sandbox: expect.objectContaining({ mode: "off" }),
    });
  });

  it("rejects an invalid mode without touching config (error)", () => {
    handleSandbox("yolo");
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    expect(mockResetSandboxCache).not.toHaveBeenCalled();
    expect(printedErrors.length).toBe(1);
  });
});
