/**
 * Unit tests — AuthMiddleware password validation. Every instance requires a
 * non-empty password; there is no unauthenticated mode.
 */

import { describe, expect, it } from "vitest";
import { AuthMiddleware } from "../../../../packages/server/src/auth/middleware.js";
import { ConfigurationError } from "../../../../packages/server/src/errors/index.js";

describe("AuthMiddleware — password validation", () => {
  it("authorizes an exact match", () => {
    expect(new AuthMiddleware("secret123").validate("secret123")).toBe("shared");
  });

  it("trims whitespace on both sides of the comparison", () => {
    expect(new AuthMiddleware(" secret123 ").validate("secret123")).toBe(
      "shared",
    );
    expect(new AuthMiddleware("secret123").validate(" secret123 ")).toBe(
      "shared",
    );
  });

  it("rejects a mismatch", () => {
    expect(new AuthMiddleware("secret123").validate("wrong")).toBeNull();
  });

  it("rejects an empty client password when a password is configured", () => {
    expect(new AuthMiddleware("secret123").validate("")).toBeNull();
  });

  it("rejects a mismatch of a different length without throwing", () => {
    // Validation compares fixed-width digests (see middleware.ts), not the
    // raw strings directly — a length mismatch must still resolve to a
    // clean reject, not an exception from a differing-length buffer compare.
    expect(new AuthMiddleware("secret123").validate("a-much-longer-guess")).toBeNull();
  });
});

describe("AuthMiddleware — no unauthenticated mode", () => {
  it.each([[""], ["   "], ["\t\n"]])(
    "throws when constructed with %j",
    (password) => {
      expect(() => new AuthMiddleware(password)).toThrow(ConfigurationError);
    },
  );

  it("explains that a password must be set", () => {
    expect(() => new AuthMiddleware("")).toThrow(/password/i);
  });
});
