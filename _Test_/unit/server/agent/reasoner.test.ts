/**
 * Unit tests — server orchestration/agent/reasoner.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
  parseReasonRecord,
  runReasoningPhase,
} from "../../../../packages/server/src/orchestration/agent/reasoner.js";
import { AbortError } from "../../../../packages/server/src/errors/index.js";
import type { IOllamaClient } from "../../../../packages/server/src/orchestration/interfaces.js";
import type { EffortLevel } from "../../../../packages/server/src/config/types.js";

describe("parseReasonRecord", () => {
  it("parses a well-formed record (normal)", () => {
    const raw = [
      "know: no",
      "find: read the config file first",
      "action: read_file config.json",
      "risk: the file might not exist yet",
      "exit: true",
      "conclude: I'll check the config file before changing it.",
    ].join("\n");

    expect(parseReasonRecord(raw)).toEqual({
      know: false,
      find: "read the config file first",
      action: "read_file config.json",
      risk: "the file might not exist yet",
      exit: true,
      conclude: "I'll check the config file before changing it.",
    });
  });

  it("unwraps a <reason>...</reason> block when the model adds one unprompted (boundary)", () => {
    const raw = "<reason>\nknow: yes\naction: answer\nexit: true\n</reason>";
    const record = parseReasonRecord(raw);
    expect(record.know).toBe(true);
    expect(record.action).toBe("answer");
    expect(record.exit).toBe(true);
  });

  it("defaults exit to true and conclude to null when fields are missing (boundary — tolerant parsing)", () => {
    const record = parseReasonRecord("just some prose with no fields at all");
    expect(record.exit).toBe(true);
    expect(record.conclude).toBeNull();
    expect(record.know).toBe(false);
    expect(record.find).toBe("-");
  });

  it("treats a literal 'null' conclude as no conclusion (boundary)", () => {
    const record = parseReasonRecord("exit: true\nconclude: null");
    expect(record.conclude).toBeNull();
  });

  it("parses exit: false and a 'no' know value (error/negative case)", () => {
    const record = parseReasonRecord("know: no\nexit: false\nconclude: still working it out");
    expect(record.know).toBe(false);
    expect(record.exit).toBe(false);
    expect(record.conclude).toBe("still working it out");
  });
});

const makeOllama = (chatImpl: (...args: unknown[]) => Promise<string>): IOllamaClient =>
  ({ chat: vi.fn(chatImpl) }) as unknown as IOllamaClient;

const baseParams = (ollama: IOllamaClient, effort: EffortLevel = "high") => ({
  ollama,
  model: "test-model",
  signal: new AbortController().signal,
  numCtx: undefined,
  keepAlive: "30m",
  effort,
  contextText: "Task: add a config module.",
});

describe("runReasoningPhase", () => {
  it("returns null when the model has no chat() support at all — the caller falls through to acting directly (normal — additive-by-design guard)", async () => {
    const ollama = {} as unknown as IOllamaClient; // no chat() at all, like a fixture that only mocks chatWithTools
    const outcome = await runReasoningPhase(baseParams(ollama));
    expect(outcome).toBeNull();
  });

  it("returns null when the chat call throws for a non-abort reason (error)", async () => {
    const ollama = makeOllama(async () => {
      throw new Error("connection refused");
    });
    const outcome = await runReasoningPhase(baseParams(ollama));
    expect(outcome).toBeNull();
  });

  it("propagates AbortError instead of swallowing it (error — cancellation must still work)", async () => {
    const ollama = makeOllama(async () => {
      throw new AbortError("cancelled");
    });
    await expect(runReasoningPhase(baseParams(ollama))).rejects.toBeInstanceOf(
      AbortError,
    );
  });

  it("accepts an immediate exit: true with no verification when the action is not finish (normal)", async () => {
    const chat = vi.fn(async () =>
      ["exit: true", "action: read_file a.ts", "conclude: I'll read the file first."].join(
        "\n",
      ),
    );
    const outcome = await runReasoningPhase(baseParams(makeOllama(chat)));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(outcome?.record.action).toBe("read_file a.ts");
    expect(outcome?.display).toBe("I'll read the file first.");
  });

  it("re-reasons on exit: false up to the effort level's refinement cap, then reaches exit: true within it (normal — 'high' allows 2 refinement rounds)", async () => {
    let call = 0;
    const chat = vi.fn(async () => {
      call += 1;
      if (call < 3) {
        return `exit: false\naction: still deciding\nconclude: still working out the ${call} approach.`;
      }
      return "exit: true\naction: run_command npm test\nconclude: I'll run the test suite.";
    });
    const outcome = await runReasoningPhase(baseParams(makeOllama(chat)));
    expect(chat).toHaveBeenCalledTimes(3);
    expect(outcome?.record.action).toBe("run_command npm test");
    expect(outcome?.display).toBe("I'll run the test suite.");
  });

  it("stops at the refinement cap and acts on the model's last decision — capped-out reasoning still resolves, never throws (error/negative case)", async () => {
    // A model that never sets exit: true — "high" allows 1 initial call plus
    // 2 refinement rounds, so the 3rd call's answer (still exit: false) is
    // the one the loop is forced to act on.
    let call = 0;
    const chat = vi.fn(async () => {
      call += 1;
      return `exit: false\naction: still deciding round ${call}\nconclude: still working it out.`;
    });
    const outcome = await runReasoningPhase(baseParams(makeOllama(chat)));
    expect(chat).toHaveBeenCalledTimes(3);
    expect(outcome?.record.exit).toBe(false);
    expect(outcome?.record.action).toBe("still deciding round 3");
  });

  it("'medium' effort allows up to 1 refinement round before capping (normal)", async () => {
    let call = 0;
    const chat = vi.fn(async () => {
      call += 1;
      return `exit: false\naction: still deciding round ${call}\nconclude: still working it out.`;
    });
    const outcome = await runReasoningPhase(baseParams(makeOllama(chat), "medium"));
    expect(chat).toHaveBeenCalledTimes(2); // 1 initial + 1 refinement round
    expect(outcome?.record.action).toBe("still deciding round 2");
  });

  it("'medium' effort reaches exit: true within its cap when the model is ready sooner (normal)", async () => {
    let call = 0;
    const chat = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return "exit: false\naction: still deciding\nconclude: not sure yet.";
      }
      return "exit: true\naction: read_file a.ts\nconclude: I'll take a look.";
    });
    const outcome = await runReasoningPhase(baseParams(makeOllama(chat), "medium"));
    expect(chat).toHaveBeenCalledTimes(2); // 1 initial + 1 refinement round, exits early
    expect(outcome?.record.action).toBe("read_file a.ts");
  });

  it("'max' effort allows up to 6 refinement rounds before capping (normal)", async () => {
    let call = 0;
    const chat = vi.fn(async () => {
      call += 1;
      return `exit: false\naction: still deciding round ${call}\nconclude: still working it out.`;
    });
    const outcome = await runReasoningPhase(baseParams(makeOllama(chat), "max"));
    expect(chat).toHaveBeenCalledTimes(7); // 1 initial + 6 refinement rounds
    expect(outcome?.record.action).toBe("still deciding round 7");
  });

  it("runs exactly two hidden verification passes when the action names finish, and shows nothing extra when both pass clean (normal)", async () => {
    let call = 0;
    const chat = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return "exit: true\naction: finish\nconclude: The task is complete.";
      }
      // Both verification passes find nothing wrong.
      return "exit: true\nconclude: null";
    });
    const outcome = await runReasoningPhase(baseParams(makeOllama(chat)));
    expect(chat).toHaveBeenCalledTimes(3); // 1 decision + 2 verification passes
    expect(outcome?.display).toBe("The task is complete.");
  });

  it("'medium' effort runs exactly one hidden verification pass on finish (normal)", async () => {
    let call = 0;
    const chat = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return "exit: true\naction: finish\nconclude: The task is complete.";
      }
      return "exit: true\nconclude: null";
    });
    const outcome = await runReasoningPhase(baseParams(makeOllama(chat), "medium"));
    expect(chat).toHaveBeenCalledTimes(2); // 1 decision + 1 verification pass
    expect(outcome?.display).toBe("The task is complete.");
  });

  it("surfaces a verification revision as 'Wait, I think ...' and adopts the corrected action (normal)", async () => {
    let call = 0;
    const chat = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return "exit: true\naction: finish\nconclude: The task is complete.";
      }
      if (call === 2) {
        return "exit: true\naction: read_file a.ts\nconclude: the write was never verified.";
      }
      // Second pass, over the (already-corrected) decision — clean.
      return "exit: true\nconclude: null";
    });
    const outcome = await runReasoningPhase(baseParams(makeOllama(chat)));
    expect(chat).toHaveBeenCalledTimes(3);
    expect(outcome?.display).toBe("Wait, I think the write was never verified.");
    expect(outcome?.record.action).toBe("read_file a.ts");
  });

  it("sends the prior record back for refinement instead of reasoning cold on the next round (normal)", async () => {
    let call = 0;
    const chat = vi.fn(async (_model: string, messages: { role: string; content: string }[]) => {
      call += 1;
      if (call === 1) {
        return "exit: false\naction: thinking\nconclude: not sure yet.";
      }
      // Second call's system prompt should reference the first decision.
      const systemMessage = messages.find((m) => m.role === "system");
      expect(systemMessage?.content).toContain("YOUR PREVIOUS DECISION");
      expect(systemMessage?.content).toContain("not sure yet.");
      return "exit: true\naction: answer\nconclude: Actually, this needs no tool.";
    });
    const outcome = await runReasoningPhase(baseParams(makeOllama(chat)));
    expect(chat).toHaveBeenCalledTimes(2);
    expect(outcome?.display).toBe("Actually, this needs no tool.");
  });

  it("stops treating reasoning as available the moment a verification pass fails, keeping the pre-verification decision (error)", async () => {
    let call = 0;
    const chat = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return "exit: true\naction: finish\nconclude: Done.";
      }
      throw new Error("provider hiccup");
    });
    const outcome = await runReasoningPhase(baseParams(makeOllama(chat)));
    expect(outcome?.record.action).toBe("finish");
    expect(outcome?.display).toBe("Done.");
  });
});
