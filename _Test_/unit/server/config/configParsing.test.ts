/**
 * Unit tests — configManager parsing helpers.
 */

import { describe, expect, it } from "vitest";
import {
  mergeConfig,
  parseStoredConfig,
} from "../../../../packages/server/src/config/parsing.js";

describe("parseStoredConfig", () => {
  it("parses a valid object", () => {
    expect(parseStoredConfig('{"agentTemp": 0.5}')).toEqual({ agentTemp: 0.5 });
  });

  it("returns {} for invalid JSON", () => {
    expect(parseStoredConfig("{ broken")).toEqual({});
  });

  it("returns {} for non-object JSON", () => {
    expect(parseStoredConfig("[1,2,3]")).toEqual({});
    expect(parseStoredConfig('"string"')).toEqual({});
    expect(parseStoredConfig("null")).toEqual({});
  });
});

describe("mergeConfig", () => {
  it("fills defaults when stored config is empty", () => {
    const cfg = mergeConfig({});
    expect(cfg).toBeTypeOf("object");
    expect(cfg).toHaveProperty("agentTemp");
  });

  it("applies stored overrides", () => {
    const cfg = mergeConfig({ agentTemp: 0.25 });
    expect(cfg.agentTemp).toBe(0.25);
  });

  it("passes a valid positive-integer numCtx through unchanged", () => {
    expect(mergeConfig({ numCtx: 8192 }).numCtx).toBe(8192);
  });

  it("repairs a negative, fractional, or zero stored numCtx to undefined rather than passing it through (regression guard)", () => {
    // set() requires numCtx to be a positive integer, but mergeConfig's own
    // check only verified "finite number" — a value written before that
    // validation existed, or edited by hand, would survive loading and
    // reach Ollama's request body as an invalid num_ctx.
    expect(mergeConfig({ numCtx: -100 }).numCtx).toBeUndefined();
    expect(mergeConfig({ numCtx: 0 }).numCtx).toBeUndefined();
    expect(mergeConfig({ numCtx: 512.5 }).numCtx).toBeUndefined();
    expect(mergeConfig({ numCtx: Infinity }).numCtx).toBeUndefined();
    expect(mergeConfig({ numCtx: "4096" }).numCtx).toBeUndefined();
  });
});
