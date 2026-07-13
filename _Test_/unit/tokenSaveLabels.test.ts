/**
 * Unit tests — server orchestration/tools/tokenSaveLabels.ts
 */

import { describe, expect, it } from "vitest";
import {
  tokenSaveActivityMessage,
  tokenSaveHistoryLabel,
  tokenSaveHistoryTarget,
  tokenSaveWorkingLabel,
} from "../../packages/server/src/orchestration/tools/tokenSaveLabels.js";

describe("tokenSaveHistoryLabel", () => {
  it("maps known tools to short labels", () => {
    expect(tokenSaveHistoryLabel("tokensave_search")).toBe("Search");
    expect(tokenSaveHistoryLabel("tokensave_context")).toBe("Context");
    expect(tokenSaveHistoryLabel("tokensave_callers")).toBe("Callers");
    expect(tokenSaveHistoryLabel("tokensave_status")).toBe("Index");
  });
});

describe("tokenSaveHistoryTarget", () => {
  it("uses query for tokensave_search", () => {
    expect(tokenSaveHistoryTarget("tokensave_search", { query: "orchestrator" })).toBe(
      "orchestrator",
    );
  });

  it("defaults search target to codebase when query missing", () => {
    expect(tokenSaveHistoryTarget("tokensave_search", {})).toBe("codebase");
  });

  it("truncates long targets", () => {
    const long = "a".repeat(80);
    const target = tokenSaveHistoryTarget("tokensave_search", { query: long });
    expect(target).toHaveLength(61);
    expect(target.endsWith("…")).toBe(true);
  });

  it("uses symbol for callers", () => {
    expect(tokenSaveHistoryTarget("tokensave_callers", { symbol: "runTask" })).toBe(
      "runTask",
    );
  });

  it("returns status for tokensave_status", () => {
    expect(tokenSaveHistoryTarget("tokensave_status", {})).toBe("status");
  });
});

describe("tokenSaveActivityMessage", () => {
  it("formats search with quoted query", () => {
    expect(
      tokenSaveActivityMessage("tokensave_search", { query: "auth flow" }),
    ).toBe('Searching "auth flow"...');
  });

  it("formats generic codebase search", () => {
    expect(tokenSaveActivityMessage("tokensave_search", {})).toBe(
      "Searching codebase...",
    );
  });

  it("formats callers lookup", () => {
    expect(
      tokenSaveActivityMessage("tokensave_callers", { symbol: "Advisor.plan" }),
    ).toBe("Finding callers of Advisor.plan...");
  });

  it("formats index status check", () => {
    expect(tokenSaveActivityMessage("tokensave_status", {})).toBe(
      "Checking code index...",
    );
  });
});

describe("tokenSaveWorkingLabel", () => {
  it("strips trailing ellipsis from activity message", () => {
    expect(
      tokenSaveWorkingLabel("tokensave_search", { query: "foo" }),
    ).toBe('Searching "foo"');
  });
});
