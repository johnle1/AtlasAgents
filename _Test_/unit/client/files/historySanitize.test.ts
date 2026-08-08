/**
 * Unit tests — historySanitize.ts
 *
 * Tests the `sanitizeHistoryLine` function which masks sensitive values
 * from the command-line input history before they are written to disk.
 *
 * Testing pyramid layer : Unit
 * Runner                 : Vitest
 * Mocks                  : none (pure function, no I/O)
 *
 * Category checklist (from test-skills/SKILL.md):
 *   ✅ Normal  — typical, expected input
 *   ✅ Boundary — edge cases (empty string, command with no value, casing)
 *   ✅ Error   — values that should NOT be masked (incorrect patterns)
 */

import { describe, expect, it } from "vitest";
import { sanitizeHistoryLine } from "../../../../packages/client/src/ui/historySanitize";

// ---------------------------------------------------------------------------
// Normal cases
// ---------------------------------------------------------------------------

describe("sanitizeHistoryLine — normal cases", () => {
  it("masks a password value that follows /set password (normal)", () => {
    // A typical user entry: the value after the space should become ***
    const result = sanitizeHistoryLine("/set password my_secret_123");
    expect(result).toBe("/set password ***");
  });

  it("masks a password value with a complex string (normal)", () => {
    // Real-world password with symbols — anything after /set password <space> is masked
    const result = sanitizeHistoryLine("/set password P@$$w0rd!#2024");
    expect(result).toBe("/set password ***");
  });

  it("returns a plain task prompt unchanged (normal)", () => {
    // Regular user prompts must never be altered
    const result = sanitizeHistoryLine("add a login page with authentication");
    expect(result).toBe("add a login page with authentication");
  });

  it("returns a non-password slash-command unchanged (normal)", () => {
    // Only the /set password pattern triggers masking
    const result = sanitizeHistoryLine("/set server localhost");
    expect(result).toBe("/set server localhost");
  });

  it("returns /models pull command unchanged (normal)", () => {
    const result = sanitizeHistoryLine("/models pull gemma3:27b");
    expect(result).toBe("/models pull gemma3:27b");
  });
});

// ---------------------------------------------------------------------------
// Boundary cases
// ---------------------------------------------------------------------------

describe("sanitizeHistoryLine — boundary cases", () => {
  it("returns empty string unchanged (boundary — empty input)", () => {
    // An empty string should pass through without throwing
    expect(sanitizeHistoryLine("")).toBe("");
  });

  it("does NOT mask /set password with no value following it (boundary — no value)", () => {
    // The regex requires at least one non-space char after the space;
    // '/set password' alone (no trailing value) should be left as-is
    const result = sanitizeHistoryLine("/set password");
    expect(result).toBe("/set password");
  });

  it("does NOT mask /set password with only spaces after it (boundary — only whitespace)", () => {
    // Trailing whitespace with no actual value should not trigger the mask
    const result = sanitizeHistoryLine("/set password   ");
    expect(result).toBe("/set password   ");
  });

  it("masks /SET PASSWORD in uppercase (boundary — case-insensitive)", () => {
    // The regex uses the /i flag; uppercase variants must also be protected
    const result = sanitizeHistoryLine("/SET PASSWORD mySecret");
    expect(result).toBe("/set password ***");
  });

  it("masks /Set Password in mixed case (boundary — mixed case)", () => {
    const result = sanitizeHistoryLine("/Set Password abc123");
    expect(result).toBe("/set password ***");
  });

  it("returns a single-character string unchanged (boundary — minimal input)", () => {
    expect(sanitizeHistoryLine("x")).toBe("x");
  });

  it("returns a slash alone unchanged (boundary — bare slash)", () => {
    expect(sanitizeHistoryLine("/")).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// Error / false-positive guard cases
// ---------------------------------------------------------------------------

describe("sanitizeHistoryLine — error / false-positive guards", () => {
  it("does NOT mask a string that merely contains the password pattern mid-line", () => {
    // The regex is anchored to the start (^); a mid-sentence match must not trigger
    const line = "note: /set password myvalue was used above";
    expect(sanitizeHistoryLine(line)).toBe(line);
  });

  it("does NOT mask /set passwordless (unrelated command with shared prefix)", () => {
    // 'passwordless' starts with 'password' but the full word is different
    const line = "/set passwordless true";
    expect(sanitizeHistoryLine(line)).toBe(line);
  });

  it("does NOT mask a string that is just the word 'password'", () => {
    const line = "password";
    expect(sanitizeHistoryLine(line)).toBe(line);
  });
});
