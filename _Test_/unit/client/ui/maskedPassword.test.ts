/**
 * Unit tests — utils/maskedPassword.ts (non-TTY piped stdin path).
 */

import { afterEach, describe, expect, it } from "vitest";
import { readMaskedPassword } from "../../../../packages/client/src/utils/maskedPassword.js";

describe("readMaskedPassword — piped stdin", () => {
  const originalIsTTY = process.stdin.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it("reads a line from buffered stdin when not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    const promise = readMaskedPassword("Password: ");
    process.stdin.emit("data", "secret123\n");
    await expect(promise).resolves.toBe("secret123");
  });
});
