/**
 * Unit tests — server orchestration/tools/tokenSaveToolHandler.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
  createTokenSaveToolHandlers,
  formatMcpData,
} from "../../packages/server/src/orchestration/tools/tokenSaveToolHandler.js";
import type { ToolSchema } from "../../packages/server/src/orchestration/tools/types.js";

const schema = (name: string): ToolSchema => ({
  type: "function",
  function: {
    name,
    description: name,
    parameters: { type: "object", properties: {}, required: [] },
  },
});

const mockCtx = (
  workspace: { callMcpTool: ReturnType<typeof vi.fn> },
  escalationCount = 0,
) => {
  const emitSubagentStatus = vi.fn();
  return {
    ctx: {
      workspace,
      escalationCount,
      emitSubagentStatus,
    } as never,
    emitSubagentStatus,
  };
};

describe("formatMcpData", () => {
  it("returns strings unchanged", () => {
    expect(formatMcpData("hello")).toBe("hello");
  });

  it("JSON-stringifies objects with 2-space indent", () => {
    expect(formatMcpData({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("returns undefined for undefined input", () => {
    expect(formatMcpData(undefined)).toBeUndefined();
  });

  it("stringifies null", () => {
    expect(formatMcpData(null)).toBe("null");
  });
});

describe("createTokenSaveToolHandlers", () => {
  it("returns one handler per schema", () => {
    const handlers = createTokenSaveToolHandlers([
      schema("tokensave_search"),
      schema("tokensave_status"),
    ]);
    expect(handlers).toHaveLength(2);
    expect(handlers[0]?.schema.function.name).toBe("tokensave_search");
    expect(typeof handlers[0]?.execute).toBe("function");
  });

  it("formats success feedback with observation wrapper", async () => {
    const [handler] = createTokenSaveToolHandlers([schema("tokensave_search")]);
    const callMcpTool = vi.fn().mockResolvedValue({
      isError: false,
      data: "result text",
    });
    const { ctx, emitSubagentStatus } = mockCtx({ callMcpTool });
    const result = await handler!.execute({ query: "foo" }, ctx);
    expect(emitSubagentStatus).toHaveBeenCalledWith(
      "searching",
      "◌",
      'Searching "foo"...',
    );
    expect(callMcpTool).toHaveBeenCalledWith(
      "tokensave_search",
      { query: "foo" },
      60_000,
    );
    expect(result.feedback).toContain("[tokensave_search]");
    expect(result.feedback).toContain("result text");
    expect(result.done).toBe(false);
  });

  it("formats error feedback with error message", async () => {
    const [handler] = createTokenSaveToolHandlers([schema("tokensave_search")]);
    const { ctx } = mockCtx({
      callMcpTool: vi.fn().mockResolvedValue({
        isError: true,
        errorMessage: "boom",
      }),
    });
    const result = await handler!.execute({ query: "foo" }, ctx);
    expect(result.feedback).toContain("[tokensave error]: boom");
  });

  it("uses unknown error when errorMessage is missing", async () => {
    const [handler] = createTokenSaveToolHandlers([schema("tokensave_search")]);
    const { ctx } = mockCtx({
      callMcpTool: vi.fn().mockResolvedValue({ isError: true }),
    });
    const result = await handler!.execute({}, ctx);
    expect(result.feedback).toContain("[tokensave error]: unknown error");
  });

  it("uses 120s timeout for impact and callers tools", async () => {
    const handlers = createTokenSaveToolHandlers([
      schema("tokensave_impact"),
      schema("tokensave_callers"),
      schema("tokensave_search"),
    ]);
    const callMcpTool = vi.fn().mockResolvedValue({ isError: false, data: "x" });
    const { ctx } = mockCtx({ callMcpTool });

    await handlers[0]!.execute({}, ctx);
    await handlers[1]!.execute({}, ctx);
    await handlers[2]!.execute({}, ctx);

    expect(callMcpTool).toHaveBeenNthCalledWith(1, "tokensave_impact", {}, 120_000);
    expect(callMcpTool).toHaveBeenNthCalledWith(2, "tokensave_callers", {}, 120_000);
    expect(callMcpTool).toHaveBeenNthCalledWith(3, "tokensave_search", {}, 60_000);
  });
});
