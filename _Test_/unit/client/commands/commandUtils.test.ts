/**
 * Unit tests — packages/client/src/commands/utils.ts
 */

import { describe, expect, it } from "vitest";
import {
  formatErrorMessage,
  parsePort,
} from "../../../../packages/client/src/commands/utils.js";

describe("parsePort", () => {
  it("parses valid ports in range", () => {
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort(" 7000 ")).toBe(7000);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort("1")).toBe(1);
  });

  it("rejects out-of-range and invalid input", () => {
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("-1")).toBeNull();
    expect(parsePort("abc")).toBeNull();
    expect(parsePort("")).toBeNull();
  });
});

describe("formatErrorMessage", () => {
  it("returns Error.message for Error instances", () => {
    expect(formatErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(formatErrorMessage("plain")).toBe("plain");
    expect(formatErrorMessage(42)).toBe("42");
  });
});
