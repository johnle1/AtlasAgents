/**
 * Unit tests — ollama/lifecycle.ts ensureOllamaRunning
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureOllamaRunning } from "../../../../packages/server/src/ollama/lifecycle.js";

describe("ensureOllamaRunning", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns startedByServer false when Ollama already responds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true }),
    );

    const lifecycle = await ensureOllamaRunning("http://127.0.0.1:11434/api/tags");
    expect(lifecycle.startedByServer).toBe(false);
    lifecycle.stop();
    expect(fetch).toHaveBeenCalled();
  });
});
