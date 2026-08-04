/**
 * Unit tests — memory/consolidation/consolidationScheduler.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleConsolidation } from "../../../../packages/server/src/memory/consolidation/consolidationScheduler.js";

describe("scheduleConsolidation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs consolidation when lastConsolidatedAt is missing", async () => {
    const consolidate = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockResolvedValue({});
    const set = vi.fn().mockResolvedValue(undefined);

    scheduleConsolidation({
      config: { getAll, set },
      prefs: { consolidate },
    });

    await vi.waitFor(() => {
      expect(consolidate).toHaveBeenCalledTimes(1);
    });
    expect(set).toHaveBeenCalledWith(
      "lastConsolidatedAt",
      expect.any(String),
    );
  });

  it("skips consolidation when a recent lastConsolidatedAt is set", async () => {
    const consolidate = vi.fn().mockResolvedValue(undefined);
    const getAll = vi.fn().mockResolvedValue({
      lastConsolidatedAt: new Date().toISOString(),
    });
    const set = vi.fn().mockResolvedValue(undefined);

    scheduleConsolidation({
      config: { getAll, set },
      prefs: { consolidate },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(consolidate).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
