/**
 * Unit tests — syncModelToolSupport / syncSubagentToolSupport.
 */

import { describe, expect, it, vi } from "vitest";
import {
  syncModelToolSupport,
  syncSubagentToolSupport,
} from "../../../../packages/server/src/ollama/syncAgentToolSupport.js";

describe("syncModelToolSupport", () => {
  it("returns cached value for empty model name without probing", async () => {
    const showModel = vi.fn();
    const config = {
      set: vi.fn(),
      getSubagentModelSupportsTools: vi.fn().mockResolvedValue(true),
    };
    await expect(
      syncModelToolSupport( { showModel }, config, "subagent", "  "),
    ).resolves.toBe(true);
    expect(showModel).not.toHaveBeenCalled();
  });

  it("persists probed tool support for subagent role", async () => {
    const showModel = vi.fn().mockResolvedValue({
      capabilities: ["completion", "tools"],
    });
    const set = vi.fn().mockResolvedValue(undefined);
    const config = {
      set,
      getSubagentModelSupportsTools: vi.fn().mockResolvedValue(false),
    };
    await expect(
      syncModelToolSupport({ showModel }, config, "subagent", "gemma3:27b"),
    ).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith("subagentModelSupportsTools", true);
  });

  it("falls back to cached value when probe fails", async () => {
    const config = {
      set: vi.fn(),
      getAgentModelSupportsTools: vi.fn().mockResolvedValue(false),
    };
    await expect(
      syncModelToolSupport(
        { showModel: vi.fn().mockRejectedValue(new Error("down")) },
        config,
        "agent",
        "llama3",
      ),
    ).resolves.toBe(false);
  });
});

describe("syncSubagentToolSupport", () => {
  it("delegates to syncModelToolSupport for the subagent role", async () => {
    const showModel = vi.fn().mockResolvedValue({ capabilities: [] });
    const set = vi.fn().mockResolvedValue(undefined);
    const config = {
      set,
      getSubagentModelSupportsTools: vi.fn().mockResolvedValue(false),
    };
    await expect(
      syncSubagentToolSupport({ showModel }, config, "m"),
    ).resolves.toBe(false);
    expect(showModel).toHaveBeenCalled();
  });
});
