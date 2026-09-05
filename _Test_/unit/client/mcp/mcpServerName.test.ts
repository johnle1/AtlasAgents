/**
 * Unit tests — client mcp/mcpServerName.ts
 *
 * Category checklist:
 * - Normal: valid ids pass; hostname -> id derivation; de-duplication
 * - Boundary: length limit, generic-only hosts, multi-label hosts
 * - Error: empty, reserved, "__", and invalid characters are rejected
 */

import { describe, expect, it } from "vitest";
import {
  RESERVED_SERVER_IDS,
  deriveServerId,
  validateServerId,
} from "../../../../packages/client/src/mcp/mcpServerName.js";

describe("validateServerId", () => {
  it("accepts a simple lowercase id (normal)", () => {
    expect(validateServerId("github")).toEqual({ ok: true });
  });

  it("accepts hyphens and underscores (normal)", () => {
    expect(validateServerId("my-api")).toEqual({ ok: true });
    expect(validateServerId("my_api")).toEqual({ ok: true });
  });

  it("accepts digits (normal)", () => {
    expect(validateServerId("api2")).toEqual({ ok: true });
  });

  it("rejects an empty name (boundary)", () => {
    const result = validateServerId("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty");
    }
  });

  it("rejects a name over 40 characters (boundary)", () => {
    const tooLong = "a".repeat(41);
    const result = validateServerId(tooLong);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("too long");
    }
  });

  it("accepts a name at exactly the 40-character limit (boundary)", () => {
    expect(validateServerId("a".repeat(40))).toEqual({ ok: true });
  });

  it("rejects a name containing '__' (error — breaks tool-name parsing)", () => {
    const result = validateServerId("my__server");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("__");
    }
  });

  it("rejects a name with a dot (error)", () => {
    const result = validateServerId("my.server");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/letters, digits/);
    }
  });

  it("rejects a name with a space (error)", () => {
    const result = validateServerId("my server");
    expect(result.ok).toBe(false);
  });

  it("rejects the reserved id 'tokensave' (error)", () => {
    const result = validateServerId("tokensave");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("reserved");
    }
  });

  it("every reason is a non-empty string naming the offending rule (normal)", () => {
    for (const bad of ["", "a".repeat(41), "a__b", "a.b", "tokensave"]) {
      const result = validateServerId(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("RESERVED_SERVER_IDS", () => {
  it("contains tokensave (normal)", () => {
    expect(RESERVED_SERVER_IDS.has("tokensave")).toBe(true);
  });
});

describe("deriveServerId", () => {
  it("derives an id from a two-label host, stripping the leading generic label (normal)", () => {
    expect(deriveServerId("https://mcp.atlassian.com/v2/mcp", new Set())).toBe(
      "atlassian",
    );
  });

  it("strips a leading 'api' label (normal)", () => {
    expect(deriveServerId("https://api.linear.app/mcp", new Set())).toBe("linear");
  });

  it("strips a leading 'www' label (normal)", () => {
    expect(deriveServerId("https://www.example.com/mcp", new Set())).toBe("example");
  });

  it("de-dupes against taken ids with an incrementing suffix (normal)", () => {
    expect(
      deriveServerId("https://api.linear.app/mcp", new Set(["linear"])),
    ).toBe("linear-2");
    expect(
      deriveServerId(
        "https://api.linear.app/mcp",
        new Set(["linear", "linear-2"]),
      ),
    ).toBe("linear-3");
  });

  it("keeps the first meaningful label of a multi-label host (boundary)", () => {
    expect(
      deriveServerId("https://mcp.internal.example.com/mcp", new Set()),
    ).toBe("internal");
  });

  it("falls back to 'server' when every label is generic (boundary)", () => {
    expect(deriveServerId("https://mcp.api.com/mcp", new Set())).toBe("server");
  });

  it("falls back to 'server' for an unparseable URL (boundary)", () => {
    expect(deriveServerId("not-a-url", new Set())).toBe("server");
  });

  it("de-dupes the fallback id too (boundary)", () => {
    expect(deriveServerId("not-a-url", new Set(["server"]))).toBe("server-2");
  });

  it("every derived id passes validateServerId (normal — round-trip guard)", () => {
    const urls = [
      "https://mcp.atlassian.com/v2/mcp",
      "https://api.linear.app/mcp",
      "https://www.example.com/mcp",
      "https://mcp.api.com/mcp",
      "not-a-url",
    ];
    const taken = new Set<string>();
    for (const url of urls) {
      const id = deriveServerId(url, taken);
      expect(validateServerId(id)).toEqual({ ok: true });
      taken.add(id);
    }
  });
});
