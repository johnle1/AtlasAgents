/**
 * Unit tests — server orchestration/agent/agentTurn.ts
 *
 * @remarks
 * This is the regression guard for the original complaint this rewrite
 * exists to fix: typing "hello" used to run a full planner scaffold and
 * dispatch a subagent before producing anything useful. These tests drive
 * the REAL `runAgentTurn` loop directly (no pipeline, no RSocket) against a
 * fake `IOllamaClient`, asserting on call counts and message content —
 * fast, precise, and independent of the integration-level coverage in
 * orchestratorPipelineFlow.test.ts / thinkStreamFlow.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { runAgentTurn } from "../../../../packages/server/src/orchestration/agent/agentTurn.js";
import type {
  IConfigManager,
  IOllamaClient,
} from "../../../../packages/server/src/orchestration/interfaces.js";
import type { PerConnection } from "../../../../packages/server/src/container/types.js";
import type { Message } from "../../../../packages/server/src/orchestration/types.js";
import type { TaskFrame } from "../../../../packages/server/src/transport/frames.js";

const nativeConfig = {
  getAgentModel: async () => "test-agent",
  getAgentTemperature: async () => 0,
  getAgentModelSupportsTools: async () => true,
} as unknown as IConfigManager;

const legacyConfig = {
  ...nativeConfig,
  getAgentModelSupportsTools: async () => false,
} as unknown as IConfigManager;

const makePerConn = (overrides: Partial<PerConnection> = {}): PerConnection =>
  ({
    mcpTools: undefined,
    workspace: {},
    terminal: {},
    planBroker: { request: vi.fn(async () => ({ decision: "implement" })) },
    activePlan: undefined,
    ...overrides,
  }) as unknown as PerConnection;

const baseParams = (perConn: PerConnection) => ({
  taskId: "t1",
  taskText: "hello",
  contextHeader: "",
  skillBody: "",
  clientEnv: undefined,
  perConn,
  modelOverrides: undefined,
  approvalMode: "default" as const,
  maxSubagents: 3 as const,
  signal: new AbortController().signal,
  // Deliberately large so none of the tests above accidentally exercise
  // compaction — the context-budget describe block below overrides this
  // with a small window to test compaction specifically.
  contextWindow: 100_000,
});

describe("runAgentTurn — direct answer (the core regression guard)", () => {
  it("answers a greeting with exactly one model call and no tool calls at all", async () => {
    const chatWithTools = vi.fn(async () => ({
      content: "Hello! How can I help?",
      thinking: "",
      toolCalls: [],
    }));
    const emitted: string[] = [];
    const frames: TaskFrame[] = [];

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn()),
        taskText: "hello",
        emit: (frame) => frames.push(frame),
        emitToken: (text) => emitted.push(text),
      },
    );

    expect(chatWithTools).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: "Hello! How can I help?", ok: true });
    expect(emitted.join("")).toBe("Hello! How can I help?");
    // No checklist was ever proposed for a bare greeting.
    expect(frames.some((f) => f.kind === "plan-update")).toBe(false);
    expect(frames.some((f) => f.kind === "confirm-plan")).toBe(false);
  });

  it("in legacy/text mode, a plain-text response with no <<TOOL>> block is treated as the direct answer", async () => {
    const chatStream = vi.fn(async function* () {
      yield "Hi there!";
    });
    const emitted: string[] = [];

    const result = await runAgentTurn(
      {
        ollama: { chatStream } as unknown as IOllamaClient,
        config: legacyConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn()),
        emit: () => {},
        emitToken: (text) => emitted.push(text),
      },
    );

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: "Hi there!", ok: true });
    expect(emitted.join("")).toBe("Hi there!");
  });
});

describe("runAgentTurn — question answered with a tool", () => {
  it("reads a known file with one read_file call, then answers", async () => {
    const readFile = vi.fn(async () => '{"name": "atlasagents"}');
    let call = 0;
    const chatWithTools = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          content: "",
          thinking: "",
          toolCalls: [{ name: "read_file", args: { path: "package.json" } }],
        };
      }
      return {
        content: 'The package is named "atlasagents".',
        thinking: "",
        toolCalls: [],
      };
    });

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ workspace: { readFile } as never })),
        taskText: "what's in package.json?",
        emit: () => {},
        emitToken: () => {},
      },
    );

    expect(readFile).toHaveBeenCalledWith("package.json", expect.anything());
    expect(chatWithTools).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("atlasagents");
  });

  it("answers a git question with run_command, not a plan", async () => {
    const runWithConfirmation = vi.fn(async () => ({
      exitCode: 0,
      stdout: "abc1234 fix the thing\ndef5678 add tests\n",
      stderr: "",
    }));
    let call = 0;
    const chatWithTools = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          content: "",
          thinking: "",
          toolCalls: [
            {
              name: "run_command",
              args: { command: "git log --oneline -5", purpose: "verify" },
            },
          ],
        };
      }
      return {
        content: "The last commits are: fix the thing, add tests.",
        thinking: "",
        toolCalls: [],
      };
    });

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ terminal: { runWithConfirmation } as never })),
        taskText: "what were the last commits?",
        emit: () => {},
        emitToken: () => {},
      },
    );

    expect(runWithConfirmation).toHaveBeenCalledWith(
      "git log --oneline -5",
      expect.anything(),
      expect.objectContaining({ background: false }),
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("fix the thing");
  });
});

describe("runAgentTurn — malformed output recovery", () => {
  it("executes every tool call in a batched response, in order, as separate assistant/tool pairs", async () => {
    const readFile = vi.fn(async (path: string) =>
      path === "a.ts" ? "content of a" : "content of b",
    );
    let call = 0;
    const chatWithTools = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          content: "Reading both files.",
          thinking: "",
          toolCalls: [
            { name: "read_file", args: { path: "a.ts" } },
            { name: "read_file", args: { path: "b.ts" } },
          ],
        };
      }
      return { content: "Both files read.", thinking: "", toolCalls: [] };
    });

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ workspace: { readFile } as never })),
        emit: () => {},
        emitToken: () => {},
      },
    );

    // Both calls actually ran, in order — nothing rejected or skipped.
    expect(readFile.mock.calls[0]?.[0]).toBe("a.ts");
    expect(readFile.mock.calls[1]?.[0]).toBe("b.ts");
    expect(chatWithTools).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);

    // Each call got its own assistant/tool pair — never one assistant
    // message carrying both tool_calls (see runToolCalls's docstring for
    // why: providers/messageTranslation.ts correlates tool results back to
    // calls by tool name, so two same-named calls in one assistant turn
    // would collide).
    const secondCallMessages = chatWithTools.mock.calls[1]![1] as Message[];
    const assistantToolTurns = secondCallMessages.filter(
      (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0,
    );
    expect(assistantToolTurns).toHaveLength(2);
    expect(assistantToolTurns[0]?.tool_calls).toHaveLength(1);
    expect(assistantToolTurns[1]?.tool_calls).toHaveLength(1);
    const toolResults = secondCallMessages.filter((m) => m.role === "tool");
    expect(toolResults).toHaveLength(2);
  });

  it("stops with a clear failure after exceeding the iteration ceiling", async () => {
    // Always proposes a tool call that never resolves the turn (finish is
    // never called), forcing the loop to run out its safety ceiling.
    const chatWithTools = vi.fn(async () => ({
      content: "",
      thinking: "",
      toolCalls: [{ name: "read_file", args: { path: "loop.ts" } }],
    }));
    const readFile = vi.fn(async () => "content");

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ workspace: { readFile } as never })),
        emit: () => {},
        emitToken: () => {},
      },
    );

    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/exceeded the maximum/i);
  });
});

describe("runAgentTurn — reasoning-tag safety net", () => {
  it("strips an unclosed <think> block from a truncated response instead of leaking it", async () => {
    const emitted: string[] = [];
    const chatWithTools = vi.fn(async () => ({
      // The model was cut off mid-reasoning — no closing </think> tag at all.
      content: "<think>still reasoning about the approach and never finished",
      thinking: "",
      toolCalls: [],
    }));

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn()),
        emit: () => {},
        emitToken: (text) => emitted.push(text),
      },
    );

    expect(result.content).not.toContain("<think>");
    expect(result.content).not.toContain("still reasoning");
    expect(emitted.join("")).not.toContain("<think>");
  });
});

describe("runAgentTurn — plan handoff across a model switch", () => {
  it("prepends a resume block summarizing the carried-over checklist when steps are unfinished", async () => {
    const chatWithTools = vi.fn(async () => ({
      content: "Continuing from where the last model left off.",
      thinking: "",
      toolCalls: [],
    }));

    await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(
          makePerConn({
            activePlan: [
              { id: 1, text: "read the config parser", status: "done" },
              { id: 2, text: "wire the flag into routerBuilder", status: "in_progress" },
              { id: 3, text: "update the tests", status: "pending" },
            ],
          }),
        ),
        emit: () => {},
        emitToken: () => {},
      },
    );

    const messages = chatWithTools.mock.calls[0]![1] as Message[];
    const systemMessage = messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain("CARRIED-OVER PLAN");
    expect(systemMessage?.content).toContain("1/3 done");
    expect(systemMessage?.content).toContain("wire the flag into routerBuilder");
    expect(systemMessage?.content).toContain("Continue from step 2");
  });

  it("omits the resume block when there is no active plan", async () => {
    const chatWithTools = vi.fn(async () => ({
      content: "hi",
      thinking: "",
      toolCalls: [],
    }));

    await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      { ...baseParams(makePerConn()), emit: () => {}, emitToken: () => {} },
    );

    const messages = chatWithTools.mock.calls[0]![1] as Message[];
    const systemMessage = messages.find((m) => m.role === "system");
    expect(systemMessage?.content).not.toContain("CARRIED-OVER PLAN");
  });

  it("omits the resume block once every step is already done", async () => {
    const chatWithTools = vi.fn(async () => ({
      content: "hi",
      thinking: "",
      toolCalls: [],
    }));

    await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(
          makePerConn({
            activePlan: [{ id: 1, text: "done step", status: "done" }],
          }),
        ),
        emit: () => {},
        emitToken: () => {},
      },
    );

    const messages = chatWithTools.mock.calls[0]![1] as Message[];
    const systemMessage = messages.find((m) => m.role === "system");
    expect(systemMessage?.content).not.toContain("CARRIED-OVER PLAN");
  });

  it("a resumed turn that advances the checklist and stops with prose is nudged to keep going, not accepted as final", async () => {
    let call = 0;
    const chatWithTools = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        // Progresses the carried-over checklist — step 2 done, step 3 still
        // pending — then, on the very next call, tries to stop with prose.
        return {
          content: "",
          thinking: "",
          toolCalls: [
            {
              name: "update_plan",
              args: {
                steps: [
                  { id: 1, text: "read the config parser", status: "done" },
                  { id: 2, text: "wire the flag into routerBuilder", status: "done" },
                  { id: 3, text: "update the tests", status: "pending" },
                ],
              },
            },
          ],
        };
      }
      if (call === 2) {
        // The exact shape of the reported "drops after 1-2 edits" bug: step
        // 3 is still pending, but the model narrates instead of acting.
        return { content: "Wired it in.", thinking: "", toolCalls: [] };
      }
      if (call === 3) {
        return {
          content: "",
          thinking: "",
          toolCalls: [
            {
              name: "update_plan",
              args: {
                steps: [
                  { id: 1, text: "read the config parser", status: "done" },
                  { id: 2, text: "wire the flag into routerBuilder", status: "done" },
                  { id: 3, text: "update the tests", status: "done" },
                ],
              },
            },
          ],
        };
      }
      return { content: "All steps complete.", thinking: "", toolCalls: [] };
    });
    const emitted: string[] = [];

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(
          makePerConn({
            activePlan: [
              { id: 1, text: "read the config parser", status: "done" },
              { id: 2, text: "wire the flag into routerBuilder", status: "in_progress" },
              { id: 3, text: "update the tests", status: "pending" },
            ],
          }),
        ),
        emit: () => {},
        emitToken: (text) => emitted.push(text),
      },
    );

    // Did NOT drop after the first edit — call 2's plain-text answer was
    // pushed back with the still-pending checklist instead of accepted.
    expect(chatWithTools).toHaveBeenCalledTimes(4);
    const followUpMessages = chatWithTools.mock.calls[2]![1] as Message[];
    const nudgeMessage = [...followUpMessages].reverse().find((m) => m.role === "user");
    expect(nudgeMessage?.content).toMatch(/checklist still has/i);
    expect(nudgeMessage?.content).toContain("update the tests");
    expect(result.ok).toBe(true);
    expect(emitted.join("")).toContain("All steps complete.");
  });
});

describe("runAgentTurn — finish and ceiling output reach the user", () => {
  it("emits the finish summary via emitToken instead of dropping it", async () => {
    const chatWithTools = vi.fn(async () => ({
      content: "",
      thinking: "",
      toolCalls: [{ name: "finish", args: { summary: "Added the OAuth flow." } }],
    }));
    const emitted: string[] = [];

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn()),
        emit: () => {},
        emitToken: (text) => emitted.push(text),
      },
    );

    expect(result.ok).toBe(true);
    expect(emitted.join("")).toContain("Added the OAuth flow.");
  });

  it("emits the iteration-ceiling message instead of returning silently", async () => {
    const chatWithTools = vi.fn(async () => ({
      content: "",
      thinking: "",
      toolCalls: [{ name: "read_file", args: { path: "loop.ts" } }],
    }));
    const readFile = vi.fn(async () => "content");
    const emitted: string[] = [];

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ workspace: { readFile } as never })),
        emit: () => {},
        emitToken: (text) => emitted.push(text),
      },
    );

    expect(result.ok).toBe(false);
    expect(emitted.join("")).toMatch(/exceeded the maximum/i);
  });
});

describe("runAgentTurn — native reasoning channel passthrough", () => {
  it("streams onThinkToken pieces straight to think frames, with no tag required", async () => {
    const chatWithTools = vi.fn(
      async (
        _model: string,
        _messages: Message[],
        _tools: unknown,
        options: { onThinkToken?: (token: string) => void },
      ) => {
        options.onThinkToken?.("weighing the options\n");
        return { content: "Here's the answer.", thinking: "", toolCalls: [] };
      },
    );
    const frames: TaskFrame[] = [];

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn()),
        emit: (frame) => frames.push(frame),
        emitToken: () => {},
      },
    );

    expect(result.ok).toBe(true);
    const kinds = frames.map((frame) => frame.kind);
    expect(kinds).toContain("think-start");
    expect(kinds).toContain("think-delta");
    expect(kinds).toContain("think-end");
    const deltaFrame = frames.find(
      (frame): frame is Extract<TaskFrame, { kind: "think-delta" }> =>
        frame.kind === "think-delta",
    );
    expect(deltaFrame?.text).toContain("weighing the options");
  });
});

describe("runAgentTurn — prose narration ahead of a tool call", () => {
  it("in native mode, emits the model's prose before running the tool call it accompanies", async () => {
    const readFile = vi.fn(async () => "content");
    let call = 0;
    const chatWithTools = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          content: "Let me check that file first.",
          thinking: "",
          toolCalls: [{ name: "read_file", args: { path: "a.ts" } }],
        };
      }
      return { content: "It looks fine.", thinking: "", toolCalls: [] };
    });
    const emitted: string[] = [];

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ workspace: { readFile } as never })),
        emit: () => {},
        emitToken: (text) => emitted.push(text),
      },
    );

    expect(result.ok).toBe(true);
    const combined = emitted.join("");
    // Narration appears BEFORE the final answer, not just concatenated
    // anywhere — proves it was emitted ahead of the tool call, not after.
    expect(combined.indexOf("Let me check that file first.")).toBeLessThan(
      combined.indexOf("It looks fine."),
    );
  });

  it("in legacy/text mode, never emits raw <<TOOL>> syntax as narration ahead of a tool call", async () => {
    const readFile = vi.fn(async () => "content");
    let call = 0;
    const chatStream = vi.fn(async function* () {
      call += 1;
      if (call === 1) {
        yield 'Let me check that file first.\n<<TOOL>>{"tool":"read_file","path":"a.ts"}<<END>>';
      } else {
        yield "It looks fine.";
      }
    });
    const emitted: string[] = [];

    const result = await runAgentTurn(
      {
        ollama: { chatStream } as unknown as IOllamaClient,
        config: legacyConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ workspace: { readFile } as never })),
        emit: () => {},
        emitToken: (text) => emitted.push(text),
      },
    );

    expect(result.ok).toBe(true);
    const combined = emitted.join("");
    expect(combined).not.toContain("<<TOOL>>");
    expect(combined).not.toContain("<<END>>");
  });

  it("does not narrate ahead of a finish call — the summary IS the answer, so narrating it too would print it twice", async () => {
    const chatWithTools = vi.fn(async () => ({
      content: "Here's your answer: the sky is blue because of Rayleigh scattering.",
      thinking: "",
      toolCalls: [
        {
          name: "finish",
          args: { summary: "Here's your answer: the sky is blue because of Rayleigh scattering." },
        },
      ],
    }));
    const emitted: string[] = [];

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn()),
        emit: () => {},
        emitToken: (text) => emitted.push(text),
      },
    );

    expect(result.ok).toBe(true);
    const combined = emitted.join("");
    const occurrences = combined.split("Rayleigh scattering").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("runAgentTurn — completion gate on the implicit text exit", () => {
  it("nudges instead of accepting an unverified write as the final answer, then accepts once verified", async () => {
    const writeFile = vi.fn(async () => ({ accepted: true, diff: "+ added" }));
    const readFile = vi.fn(async () => "content of a");
    let call = 0;
    const chatWithTools = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          content: "",
          thinking: "",
          toolCalls: [{ name: "write_file", args: { path: "a.ts", content: "x" } }],
        };
      }
      if (call === 2) {
        // Tries to stop right after the write, without verifying — the
        // implicit-exit shape the completion gate exists to catch.
        return { content: "Done, wrote the file.", thinking: "", toolCalls: [] };
      }
      if (call === 3) {
        // Reads the file back — counts as verification (readFileHandler.ts).
        return {
          content: "",
          thinking: "",
          toolCalls: [{ name: "read_file", args: { path: "a.ts" } }],
        };
      }
      return { content: "Confirmed.", thinking: "", toolCalls: [] };
    });

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ workspace: { writeFile, readFile } as never })),
        emit: () => {},
        emitToken: () => {},
      },
    );

    expect(chatWithTools).toHaveBeenCalledTimes(4);
    expect(result.ok).toBe(true);
    const followUpMessages = chatWithTools.mock.calls[2]![1] as Message[];
    const lastUserMessage = [...followUpMessages].reverse().find((m) => m.role === "user");
    expect(lastUserMessage?.content).toMatch(/verify/i);
  });

  it("escalates for two stalls, then stops honestly on the third — a model stuck with nothing to show for it", async () => {
    // The model never verifies its write and never takes any further
    // action — every empty-turn reply hits the same unverified-write gap.
    // Per the "Continue automatically" driver: 1st stall gets the plain
    // gap, 2nd stall gets an escalating directive to act, 3rd stall stops
    // honestly rather than looping forever.
    const writeFile = vi.fn(async () => ({ accepted: true, diff: "+ x" }));
    // `messages` is mutated in place throughout the loop (push/splice), so
    // `chatWithTools.mock.calls[n][1]` is the SAME array reference at every
    // index — inspecting it after the run always shows the final state, not
    // what call n actually saw. Snapshot (shallow-copy) it inside the mock
    // itself, at call time, to see each call's real input.
    const messagesSeenByCall: Message[][] = [];
    let call = 0;
    const chatWithTools = vi.fn(async (_model: string, msgs: Message[]) => {
      call += 1;
      messagesSeenByCall.push([...msgs]);
      if (call === 1) {
        return {
          content: "",
          thinking: "",
          toolCalls: [{ name: "write_file", args: { path: "a.ts", content: "x" } }],
        };
      }
      return {
        content: `Still not verifying, attempt ${call}.`,
        thinking: "",
        toolCalls: [],
      };
    });
    const emitted: string[] = [];

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ workspace: { writeFile } as never })),
        emit: () => {},
        emitToken: (text) => emitted.push(text),
      },
    );

    // 1 write + 3 stall replies: call 2 earns the plain-gap nudge, call 3
    // earns the escalating directive, call 4's reply is the 3rd stall,
    // which triggers the stop (no 4th nudge, no 5th call).
    expect(chatWithTools).toHaveBeenCalledTimes(4);
    expect(result.ok).toBe(false);
    expect(emitted.join("")).toMatch(/stopped/i);

    // 1st stall (call 2's reply) earns the plain gap — visible as the last
    // user message call 3 actually saw.
    const call3Messages = messagesSeenByCall[2]!;
    const firstFollowUp = [...call3Messages].reverse().find((m) => m.role === "user");
    expect(firstFollowUp?.content).toMatch(/verify/i);
    expect(firstFollowUp?.content).not.toMatch(/do not describe what you will do/i);

    // 2nd stall (call 3's reply) escalates — visible in what call 4 saw.
    const call4Messages = messagesSeenByCall[3]!;
    const secondFollowUp = [...call4Messages].reverse().find((m) => m.role === "user");
    expect(secondFollowUp?.content).toMatch(/do not describe what you will do/i);
    expect(secondFollowUp?.content).toMatch(/verify/i);
  });

  it("a tool call between stalls resets the streak, so narrate-then-act never terminates early", async () => {
    // Same unverified-write gap on every narrated stall, but this model
    // alternates narration with an actual tool call (read_file on an
    // UNRELATED path — real progress, but doesn't satisfy write
    // verification, so the gap stays open) between each one. Each such
    // execution must reset stallsSinceProgress, so three separate
    // single-stall cycles run without ever accumulating toward the
    // 3-in-a-row stop. The model finally reads the file it actually wrote,
    // which satisfies verification and lets the turn end normally.
    const writeFile = vi.fn(async () => ({ accepted: true, diff: "+ x" }));
    const readFile = vi.fn(async (path: string) => `content of ${path}`);
    let call = 0;
    const chatWithTools = vi.fn(async () => {
      call += 1;
      switch (call) {
        case 1:
          return {
            content: "",
            thinking: "",
            toolCalls: [
              { name: "write_file", args: { path: "a.ts", content: "x" } },
            ],
          };
        case 2:
        case 4:
        case 6:
          return {
            content: "",
            thinking: "",
            toolCalls: [{ name: "read_file", args: { path: "notes.md" } }],
          };
        case 3:
        case 5:
        case 7:
          return {
            content: `Narrating, attempt ${call}.`,
            thinking: "",
            toolCalls: [],
          };
        case 8:
          // Finally reads back the file it wrote — satisfies verification.
          return {
            content: "",
            thinking: "",
            toolCalls: [{ name: "read_file", args: { path: "a.ts" } }],
          };
        default:
          return { content: "Wrapping up.", thinking: "", toolCalls: [] };
      }
    });

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ workspace: { writeFile, readFile } as never })),
        emit: () => {},
        emitToken: () => {},
      },
    );

    // Three separate single-stall cycles (calls 3, 5, 7), none of which
    // accumulated toward the 3-in-a-row stop, because a real tool call
    // reset the streak between each one — then the file finally gets
    // verified and the turn ends normally instead of being cut off.
    expect(chatWithTools).toHaveBeenCalledTimes(9);
    expect(result.ok).toBe(true);
    expect(readFile.mock.calls.map((args) => args[0])).toEqual([
      "notes.md",
      "notes.md",
      "notes.md",
      "a.ts",
    ]);
  });

  it("keeps making progress indefinitely as long as each check-in advances the checklist", async () => {
    // Regression test for the reported bug: a real multi-step task (5
    // checklist steps) where the model alternates a tool call with a
    // narrating check-in after each one. Every tool call resets
    // stallsSinceProgress, so no check-in ever accumulates toward the
    // 3-in-a-row stop — the turn must run to completion instead of dying
    // partway through a normal number of check-ins.
    const STEP_COUNT = 5;
    const planSteps = (doneThrough: number) =>
      Array.from({ length: STEP_COUNT }, (_, index) => ({
        id: index + 1,
        text: `step ${index + 1}`,
        status: index < doneThrough ? ("done" as const) : ("pending" as const),
      }));

    let call = 0;
    const chatWithTools = vi.fn(async () => {
      call += 1;
      // Odd calls: advance the checklist by one step via update_plan.
      // Even calls: narrate with plain text, trying to stop early.
      const stepIndex = Math.ceil(call / 2);
      if (call % 2 === 1) {
        return {
          content: "",
          thinking: "",
          toolCalls: [{ name: "update_plan", args: { steps: planSteps(stepIndex) } }],
        };
      }
      if (stepIndex < STEP_COUNT) {
        return { content: `Finished step ${stepIndex}.`, thinking: "", toolCalls: [] };
      }
      return { content: "All steps complete.", thinking: "", toolCalls: [] };
    });
    const emitted: string[] = [];

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn()),
        emit: () => {},
        emitToken: (text) => emitted.push(text),
      },
    );

    // 2 calls per step (update_plan + narration) x 5 steps.
    expect(chatWithTools).toHaveBeenCalledTimes(STEP_COUNT * 2);
    expect(result.ok).toBe(true);
    expect(emitted.join("")).toContain("All steps complete.");
  });

  it("a turn that never calls a tool is never gated, even with an unfinished plan already on the connection", async () => {
    // Guards the "hello" regression now that a completion gate exists: an
    // unfinished activePlan seeds planThisTurn (resumeBlock is non-null
    // whenever any step is outstanding), but toolCallsExecuted stays 0
    // because the model never touches a tool — and the gate short-circuits
    // on that alone, so a plain reply still costs exactly one model call.
    const chatWithTools = vi.fn(async () => ({
      content: "You're welcome!",
      thinking: "",
      toolCalls: [],
    }));

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(
          makePerConn({
            activePlan: [
              { id: 1, text: "some earlier unrelated step", status: "pending" },
            ],
          }),
        ),
        taskText: "thanks!",
        emit: () => {},
        emitToken: () => {},
      },
    );

    expect(chatWithTools).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: "You're welcome!", ok: true });
  });
});

describe("runAgentTurn — context-window compaction", () => {
  // Four large read_file round trips are enough to both (a) grow the
  // conversation past the minimum length compaction requires (system + task
  // + more than 6 other messages) and (b) push a small contextWindow over
  // its 75% threshold, regardless of the real system prompt's exact size.
  const HUGE_FILE_CONTENT = "x".repeat(3500);

  const scriptFourReadsThenAnswer = (
    finalContent: string,
  ): ReturnType<typeof vi.fn> => {
    let call = 0;
    return vi.fn(async () => {
      call += 1;
      if (call <= 4) {
        return {
          content: "",
          thinking: "",
          toolCalls: [{ name: "read_file", args: { path: `file${call}.ts` } }],
        };
      }
      return { content: finalContent, thinking: "", toolCalls: [] };
    });
  };

  it("compacts the conversation via a summary call once it outgrows a small context window, preserving the system prompt, the task, and the recent tail", async () => {
    const readFile = vi.fn(async () => HUGE_FILE_CONTENT);
    const chatWithTools = scriptFourReadsThenAnswer("All done reading.");
    const chat = vi.fn(async () => "Summary: read file1.ts through file4.ts.");

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools, chat } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ workspace: { readFile } as never })),
        contextWindow: 3000,
        emit: () => {},
        emitToken: () => {},
      },
    );

    expect(result.ok).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);

    // Call 5 is the last call this test makes, so — unlike an intermediate
    // index — inspecting its recorded input after the run is safe: nothing
    // more is pushed to `messages` afterward (a final answer with no gap).
    const fifthCallMessages = chatWithTools.mock.calls[4]![1] as Message[];
    expect(fifthCallMessages[0]?.role).toBe("system");
    expect(fifthCallMessages[1]?.content).toBe("hello"); // baseParams' taskText
    const compacted = fifthCallMessages.find((m) =>
      m.content.includes("COMPACTED EARLIER WORK"),
    );
    expect(compacted).toBeDefined();
    expect(compacted?.content).toContain("Summary: read file1.ts through file4.ts.");
    // Most of the raw huge content is gone — only the protected recent tail
    // may still carry it, not every round.
    const rawOccurrences = fifthCallMessages.filter((m) =>
      m.content.includes(HUGE_FILE_CONTENT),
    ).length;
    expect(rawOccurrences).toBeLessThan(4);
  });

  it("falls back to plain elision when the summary call itself fails, and the turn still completes normally", async () => {
    const readFile = vi.fn(async () => HUGE_FILE_CONTENT);
    const chatWithTools = scriptFourReadsThenAnswer("All done reading.");
    const chat = vi.fn(async () => {
      throw new Error("summarizer unreachable");
    });

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools, chat } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ workspace: { readFile } as never })),
        contextWindow: 3000,
        emit: () => {},
        emitToken: () => {},
      },
    );

    // Compaction failing must never be what ends the turn early.
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    const fifthCallMessages = chatWithTools.mock.calls[4]![1] as Message[];
    const elided = fifthCallMessages.find((m) =>
      m.content.includes("earlier tool results elided"),
    );
    expect(elided).toBeDefined();
  });

  it("never compacts a short turn — no middle exists yet to compact", async () => {
    const readFile = vi.fn(async () => HUGE_FILE_CONTENT);
    let call = 0;
    const chatWithTools = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          content: "",
          thinking: "",
          toolCalls: [{ name: "read_file", args: { path: "a.ts" } }],
        };
      }
      return { content: "Done.", thinking: "", toolCalls: [] };
    });
    const chat = vi.fn(async () => "should not be called");

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools, chat } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn({ workspace: { readFile } as never })),
        contextWindow: 3000,
        emit: () => {},
        emitToken: () => {},
      },
    );

    expect(result.ok).toBe(true);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("runAgentTurn — cross-turn conversation memory", () => {
  it("seeds messages with prior exchanges before the current task when history exists", async () => {
    const chatWithTools = vi.fn(async () => ({
      content: "Sure, done.",
      thinking: "",
      toolCalls: [],
    }));
    const perConn = makePerConn({
      conversation: [
        { user: "create a tic-tac-toe project", assistant: "Here's the plan: 1) scaffold, 2) game logic." },
      ],
    });

    await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(perConn),
        taskText: "implement that plan for me",
        emit: () => {},
        emitToken: () => {},
      },
    );

    const messages = chatWithTools.mock.calls[0]![1] as Message[];
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "create a tic-tac-toe project" });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "Here's the plan: 1) scaffold, 2) game logic.",
    });
    expect(messages[3]).toEqual({ role: "user", content: "implement that plan for me" });
  });

  it("seeds exactly [system, task] when there is no prior history — the 'hello' guard, unaffected by memory", async () => {
    const chatWithTools = vi.fn(async () => ({
      content: "hi",
      thinking: "",
      toolCalls: [],
    }));

    await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      { ...baseParams(makePerConn()), emit: () => {}, emitToken: () => {} },
    );

    const messages = chatWithTools.mock.calls[0]![1] as Message[];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("records the exchange on perConn.conversation after the turn completes", async () => {
    const chatWithTools = vi.fn(async () => ({
      content: "The answer is 4.",
      thinking: "",
      toolCalls: [],
    }));
    const perConn = makePerConn();

    await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(perConn),
        taskText: "what's 2+2?",
        emit: () => {},
        emitToken: () => {},
      },
    );

    expect(perConn.conversation).toEqual([
      { user: "what's 2+2?", assistant: "The answer is 4." },
    ]);
  });

  it("caps stored history at the exchange limit and a single answer's stored length", async () => {
    const hugeAnswer = "y".repeat(5000);
    const chatWithTools = vi.fn(async () => ({
      content: hugeAnswer,
      thinking: "",
      toolCalls: [],
    }));
    // Seed 6 prior exchanges — at the cap already.
    const priorConversation = Array.from({ length: 6 }, (_, i) => ({
      user: `old question ${i}`,
      assistant: `old answer ${i}`,
    }));
    const perConn = makePerConn({ conversation: priorConversation });

    await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(perConn),
        taskText: "one more question",
        emit: () => {},
        emitToken: () => {},
      },
    );

    // Still capped at 6 — the oldest ("old question 0") was dropped to make
    // room for the new one.
    expect(perConn.conversation).toHaveLength(6);
    expect(perConn.conversation?.[0]?.user).toBe("old question 1");
    const newest = perConn.conversation?.[5];
    expect(newest?.user).toBe("one more question");
    // The huge answer was capped, not stored in full.
    expect(newest?.assistant.length).toBeLessThan(hugeAnswer.length);
  });

  it("protects both the seeded history and the current task from compaction (protectedPrefixCount)", async () => {
    const HUGE = "x".repeat(3500);
    const readFile = vi.fn(async () => HUGE);
    let call = 0;
    const chatWithTools = vi.fn(async () => {
      call += 1;
      if (call <= 4) {
        return {
          content: "",
          thinking: "",
          toolCalls: [{ name: "read_file", args: { path: `file${call}.ts` } }],
        };
      }
      return { content: "All done.", thinking: "", toolCalls: [] };
    });
    const chat = vi.fn(async () => "Summary of the reads.");
    const perConn = makePerConn({
      workspace: { readFile } as never,
      conversation: [{ user: "earlier question", assistant: "earlier answer" }],
    });

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools, chat } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(perConn),
        taskText: "current task",
        contextWindow: 3000,
        emit: () => {},
        emitToken: () => {},
      },
    );

    expect(result.ok).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
    // Call 5 is the last call, so its recorded input is safe to inspect
    // after the run (nothing is pushed to `messages` afterward).
    const fifthCallMessages = chatWithTools.mock.calls[4]![1] as Message[];
    expect(fifthCallMessages[0]?.role).toBe("system");
    expect(fifthCallMessages[1]).toEqual({ role: "user", content: "earlier question" });
    expect(fifthCallMessages[2]).toEqual({ role: "assistant", content: "earlier answer" });
    expect(fifthCallMessages[3]).toEqual({ role: "user", content: "current task" });
    // Nothing in the protected seed got replaced by a compaction marker.
    for (const message of fifthCallMessages.slice(0, 4)) {
      expect(message.content).not.toContain("COMPACTED EARLIER WORK");
    }
  });
});

describe("runAgentTurn — run_steps_parallel respects the session's concurrency cap", () => {
  /**
   * Builds a fake `chatWithTools` that scripts the first two calls (the
   * main turn proposing the plan, then dispatching the batch) and tracks
   * how many *later* calls — one per concurrent step, since each step is
   * completed by the same loop calling the same model client — are ever
   * in-flight at once. Regression guard for the bug where
   * run_steps_parallel hardcoded maxSubagents: "max" internally, silently
   * ignoring the session's ::focus/::collab/::max modifier.
   */
  const makeTrackingChatWithTools = (
    scripted: Array<{ toolCalls: { name: string; args: unknown }[] }>,
  ) => {
    let inFlight = 0;
    let maxInFlight = 0;
    let call = 0;
    const chatWithTools = vi.fn(async () => {
      call += 1;
      const step = scripted[call - 1];
      if (step) {
        return { content: "", thinking: "", toolCalls: step.toolCalls };
      }
      // Beyond the scripted calls: a concurrent step's own model call (or
      // the main turn's final wrap-up call) — track in-flight overlap,
      // then answer with plain text so the caller (step or turn) ends.
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield a tick so truly-concurrent calls overlap in the tracker.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { content: "done", thinking: "", toolCalls: [] };
    });
    return { chatWithTools, getMaxInFlight: () => maxInFlight };
  };

  const twoStepPlan = () => ({
    steps: [
      { id: 1, text: "setup database", status: "pending" },
      { id: 2, text: "write docs", status: "pending" },
    ],
  });

  const scriptedTurn = () => [
    { toolCalls: [{ name: "update_plan", args: twoStepPlan() }] },
    { toolCalls: [{ name: "run_steps_parallel", args: { stepIds: [1, 2] } }] },
  ];

  it("::focus (maxSubagents: 1) runs a requested batch one worker at a time", async () => {
    const { chatWithTools, getMaxInFlight } = makeTrackingChatWithTools(scriptedTurn());

    await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn()),
        maxSubagents: 1,
        emit: () => {},
        emitToken: () => {},
      },
    );

    expect(getMaxInFlight()).toBe(1);
  });

  it("default (maxSubagents: 3, DAG width 2) runs both steps of a batch concurrently", async () => {
    const { chatWithTools, getMaxInFlight } = makeTrackingChatWithTools(scriptedTurn());

    await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      {
        ...baseParams(makePerConn()),
        maxSubagents: 3,
        emit: () => {},
        emitToken: () => {},
      },
    );

    expect(getMaxInFlight()).toBe(2);
  });
});
