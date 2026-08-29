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
  it("rejects more than one tool call in a single turn and asks for exactly one", async () => {
    let call = 0;
    const chatWithTools = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          content: "",
          thinking: "",
          toolCalls: [
            { name: "read_file", args: { path: "a.ts" } },
            { name: "read_file", args: { path: "b.ts" } },
          ],
        };
      }
      return { content: "done", thinking: "", toolCalls: [] };
    });

    const result = await runAgentTurn(
      {
        ollama: { chatWithTools } as unknown as IOllamaClient,
        config: nativeConfig,
        experienceRecorder: {} as never,
      },
      { ...baseParams(makePerConn()), emit: () => {}, emitToken: () => {} },
    );

    expect(chatWithTools).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    const secondCallMessages = chatWithTools.mock.calls[1]![1] as Message[];
    const lastUserMessage = [...secondCallMessages].reverse().find((m) => m.role === "user");
    expect(lastUserMessage?.content).toMatch(/exactly one tool/i);
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
