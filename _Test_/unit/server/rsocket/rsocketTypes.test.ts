/**
 * Unit tests — RSocket command response helpers.
 */

import { describe, expect, it } from "vitest";
import {
  commandResponseBuffer,
  parsePasswordFromMetadata,
} from "../../../../packages/server/src/server/rsocket/types.js";

describe("commandResponseBuffer", () => {
  it("encodes ok responses with data", () => {
    const buf = commandResponseBuffer(true, { models: [] });
    expect(JSON.parse(buf.toString("utf8"))).toEqual({
      ok: true,
      data: { models: [] },
    });
  });

  it("encodes failure with a default error message", () => {
    const buf = commandResponseBuffer(false);
    expect(JSON.parse(buf.toString("utf8"))).toEqual({
      ok: false,
      error: "Command failed",
    });
  });

  it("encodes failure with a custom error", () => {
    const buf = commandResponseBuffer(false, undefined, "Unauthorized");
    expect(JSON.parse(buf.toString("utf8"))).toEqual({
      ok: false,
      error: "Unauthorized",
    });
  });
});

describe("parsePasswordFromMetadata", () => {
  it("returns empty string for missing/empty metadata", () => {
    expect(parsePasswordFromMetadata(undefined)).toBe("");
    expect(parsePasswordFromMetadata(null)).toBe("");
    expect(parsePasswordFromMetadata(Buffer.alloc(0))).toBe("");
  });

  it("reads a string password", () => {
    const meta = Buffer.from(JSON.stringify({ password: "secret" }), "utf8");
    expect(parsePasswordFromMetadata(meta)).toBe("secret");
  });

  it("returns empty string for invalid JSON or non-string password", () => {
    expect(parsePasswordFromMetadata(Buffer.from("{", "utf8"))).toBe("");
    expect(
      parsePasswordFromMetadata(
        Buffer.from(JSON.stringify({ password: 1 }), "utf8"),
      ),
    ).toBe("");
  });
});
