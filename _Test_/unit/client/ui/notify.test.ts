/**
 * Unit tests — client ui/notify.ts
 *
 * Opt-in OSC 9 / BEL notifications. Default off; never fire in non-TTY or
 * screen-reader-like environments; strip escape bytes from the message.
 *
 * Category checklist:
 * - Normal: OSC 9 on iTerm/WezTerm/ghostty/kitty; BEL otherwise
 * - Boundary: default-off, empty TTY, screen reader
 * - Error: strips ESC / BEL from the message (injection guard)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLoadConfig } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
}));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => mockLoadConfig(),
}));

import { notifyUser } from "../../../../packages/client/src/ui/notify.js";

const originalIsTTY = process.stdout.isTTY;

beforeEach(() => {
  mockLoadConfig.mockReturnValue({ ui: { notifications: true } });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  vi.stubEnv("TERM", "xterm-256color");
  vi.stubEnv("TERM_PROGRAM", "");
  vi.stubEnv("CI", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: originalIsTTY,
  });
});

describe("notifyUser", () => {
  it("is a no-op when ui.notifications is falsy (normal — default off)", () => {
    mockLoadConfig.mockReturnValue({ ui: { notifications: false } });
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    notifyUser("hello");
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("is a no-op when stdout is not a TTY (boundary)", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    notifyUser("hello");
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("is a no-op when a screen reader is likely (boundary)", () => {
    vi.stubEnv("TERM", "dumb");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    notifyUser("hello");
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("writes OSC 9 on iTerm.app (normal)", () => {
    vi.stubEnv("TERM_PROGRAM", "iTerm.app");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    notifyUser("Action required");
    expect(write).toHaveBeenCalledWith("\x1b]9;Action required\x07");
    write.mockRestore();
  });

  it("writes OSC 9 on WezTerm, ghostty, and kitty TERM (normal)", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    vi.stubEnv("TERM_PROGRAM", "WezTerm");
    notifyUser("a");
    expect(write).toHaveBeenLastCalledWith("\x1b]9;a\x07");

    vi.stubEnv("TERM_PROGRAM", "ghostty");
    notifyUser("b");
    expect(write).toHaveBeenLastCalledWith("\x1b]9;b\x07");

    vi.stubEnv("TERM_PROGRAM", "");
    vi.stubEnv("TERM", "xterm-kitty");
    notifyUser("c");
    expect(write).toHaveBeenLastCalledWith("\x1b]9;c\x07");

    write.mockRestore();
  });

  it("writes BEL on terminals without OSC 9 (normal)", () => {
    vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
    vi.stubEnv("TERM", "xterm-256color");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    notifyUser("Task complete");
    expect(write).toHaveBeenCalledWith("\x07");
    write.mockRestore();
  });

  it("strips ESC and BEL from the message (error — injection guard)", () => {
    vi.stubEnv("TERM_PROGRAM", "iTerm.app");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    notifyUser("hi\x1b]0;pwned\x07there");
    expect(write).toHaveBeenCalledWith("\x1b]9;hi]0;pwnedthere\x07");
    write.mockRestore();
  });
});
