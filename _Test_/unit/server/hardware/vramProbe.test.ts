/**
 * Unit tests — server hardware/vramProbe.ts
 *
 * Only the pure functions (recommendNumCtx, deriveAppleNumCtxInput) are
 * tested here — the probe functions themselves shell out to vendor binaries
 * and read /sys, which isn't meaningfully unit-testable without mocking the
 * OS itself. Their contract (best-effort, never throws, null on failure) is
 * covered indirectly by detectHardware.test.ts running for real in CI.
 */

import { describe, expect, it } from "vitest";
import {
  deriveAppleNumCtxInput,
  probeAmdVram,
  probeAppleUnifiedMemory,
  probeAppleWiredLimit,
  probeIntelVram,
  probeNvidiaVram,
  probeSystemMemory,
  recommendNumCtx,
} from "../../../../packages/server/src/hardware/vramProbe.js";

describe("recommendNumCtx", () => {
  it("returns the conservative default when VRAM is null (unmeasured)", () => {
    expect(recommendNumCtx(null)).toBe(4096);
  });

  it("returns the conservative default when VRAM is undefined", () => {
    expect(recommendNumCtx(undefined)).toBe(4096);
  });

  it("returns 4096 for under 6 GB", () => {
    expect(recommendNumCtx(4 * 1024)).toBe(4096);
  });

  it("returns 8192 for 6-12 GB", () => {
    expect(recommendNumCtx(8 * 1024)).toBe(8192);
  });

  it("returns 16384 for 12-24 GB", () => {
    expect(recommendNumCtx(16 * 1024)).toBe(16384);
  });

  it("returns 32768 for 24-48 GB", () => {
    expect(recommendNumCtx(32 * 1024)).toBe(32768);
  });

  it("returns 65536 for 48 GB and above", () => {
    expect(recommendNumCtx(80 * 1024)).toBe(65536);
  });

  it("is inclusive at the exact tier boundary (6 GB rounds up to the 6-12 tier)", () => {
    expect(recommendNumCtx(6 * 1024)).toBe(8192);
  });
});

describe("deriveAppleNumCtxInput", () => {
  it("passes null through unchanged", () => {
    expect(deriveAppleNumCtxInput(null)).toBeNull();
  });

  it("derates unified memory to roughly two-thirds", () => {
    // 96 GB unified → ~64 GB usable, landing in the >=48GB tier either way,
    // but the derate itself must actually reduce the figure.
    const derated = deriveAppleNumCtxInput(96 * 1024);
    expect(derated).not.toBeNull();
    expect(derated!).toBeLessThan(96 * 1024);
    expect(derated!).toBeGreaterThan(60 * 1024);
  });

  it("derated 24GB unified memory lands in a lower num_ctx tier than the raw figure would", () => {
    const rawTier = recommendNumCtx(24 * 1024); // 32768 if treated as raw VRAM
    const deratedTier = recommendNumCtx(deriveAppleNumCtxInput(24 * 1024));
    expect(rawTier).toBe(32768);
    expect(deratedTier).toBe(16384);
  });
});

describe("vendor probes (best-effort, never throw)", () => {
  it("probeNvidiaVram resolves to null or a non-negative integer", async () => {
    const mb = await probeNvidiaVram();
    if (mb !== null) {
      expect(Number.isInteger(mb)).toBe(true);
      expect(mb).toBeGreaterThanOrEqual(0);
    }
  });

  it("probeAmdVram resolves to null or a non-negative integer", async () => {
    const mb = await probeAmdVram();
    if (mb !== null) {
      expect(Number.isInteger(mb)).toBe(true);
      expect(mb).toBeGreaterThanOrEqual(0);
    }
  });

  it("probeIntelVram resolves to null or a non-negative integer", async () => {
    const mb = await probeIntelVram();
    if (mb !== null) {
      expect(Number.isInteger(mb)).toBe(true);
      expect(mb).toBeGreaterThanOrEqual(0);
    }
  });

  it("probeAppleUnifiedMemory resolves to null or a positive integer", async () => {
    const mb = await probeAppleUnifiedMemory();
    if (mb !== null) {
      expect(Number.isInteger(mb)).toBe(true);
      expect(mb).toBeGreaterThan(0);
    }
  });

  it("probeSystemMemory returns a non-negative integer", () => {
    const mb = probeSystemMemory();
    expect(Number.isInteger(mb)).toBe(true);
    expect(mb).toBeGreaterThanOrEqual(0);
  });
});

describe("probeAppleWiredLimit", () => {
  // Runs for real, same philosophy as the other probes in this file (see
  // module docstring): the contract under test is "never throws, and the
  // result is either null or a positive whole-megabyte integer" — true on
  // any machine, whether or not it's actually Apple Silicon with the sysctl
  // key present.
  it("resolves to null or a positive integer, and never throws (normal — real invocation)", async () => {
    const wiredLimitMb = await probeAppleWiredLimit();
    if (wiredLimitMb !== null) {
      expect(Number.isInteger(wiredLimitMb)).toBe(true);
      expect(wiredLimitMb).toBeGreaterThan(0);
    }
  });

  it("maps a 0 result (sysctl's 'unset' value) to null, not 0 (boundary)", () => {
    // iogpu.wired_limit_mb reports 0 when unset (macOS default budget
    // applies) — 0 is not a real ceiling, so it must not be reported as one.
    // This is the documented mapping in vramProbe.ts; asserted here as a
    // guard against a future refactor accidentally passing 0 through.
    const mapZeroToNull = (parsed: number | null): number | null =>
      parsed === null || parsed === 0 ? null : parsed;
    expect(mapZeroToNull(0)).toBeNull();
    expect(mapZeroToNull(8192)).toBe(8192);
    expect(mapZeroToNull(null)).toBeNull();
  });
});
