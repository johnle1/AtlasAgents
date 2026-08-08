/**
 * Unit tests — Subagent.run() no-progress circuit breaker
 *
 * @remarks
 * A subagent driven by a weak model can "think" forever without ever
 * emitting a usable tool call — every retry/escalation path in
 * `runIteration` costs a full model round trip, so without a stagnation
 * detector the only bound was `MAX_TOOL_ITERATIONS` (300), which can take
 * hours on a slow local model. These tests drive the real `Subagent.run()`
 * loop through each unproductive-turn shape (never-emitted tool call,
 * unterminated think block, unrecognized tool name, repeatedly-rejected
 * finish) and confirm the breaker trips at exactly `MAX_UNPRODUCTIVE_TURNS`
 * (8) model calls — plus a guard that a long but genuinely productive run
 * never trips it — and confirms the think-block tool-call recovery path
 * that rescues the common failure shape, restricted to read-only tools.
 */

import { describe, expect, it } from "vitest";
import type { IOllamaClient } from "../../../../packages/server/src/orchestration/interfaces.js";
import {
  baseRunParams,
  commandPlanWithSetup,
  fakeAdvisingAgent,
  fakeEscalationRecorder,
  fakeReadOnlyWorkspace,
  makeSubagent,
  nativeConfig,
  textModeConfig,
} from "../../../helpers/fakeSubagentHarness.js";

/** A fully-closed think block with valid command-plan sections plus the given body. */
const closedThink = (body: string): string =>
  [
    "<redacted_thinking>",
    "Setup commands: none",
    "Verify commands: none",
    "Off-limits (run-project): none",
    body,
    "</redacted_thinking>",
  ].join("\n");

describe("Subagent no-progress breaker", () => {
  it("trips after 8 turns when the model names an action but never emits a tool call (headline regression)", async () => {
    let callCount = 0;
    const ollama = {
      chatStream: async function* (): AsyncGenerator<string> {
        callCount += 1;
        const text = closedThink(
          "action: read_file\nrisk: not sure which file yet, need to explore further.",
        );
        for (const character of text) {
          yield character;
        }
      },
    } as unknown as IOllamaClient;

    const subagent = makeSubagent(ollama, textModeConfig, fakeAdvisingAgent());
    const result = await subagent.run(
      baseRunParams(() => {}, { recorder: fakeEscalationRecorder() }),
    );

    // Without the fix this runs up to MAX_TOOL_ITERATIONS (300).
    expect(callCount).toBe(8);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no progress/i);
  });

  it("trips after 8 turns when the think block is never closed (extractThinking returns null, never escalates)", async () => {
    let callCount = 0;
    const ollama = {
      chatStream: async function* (): AsyncGenerator<string> {
        callCount += 1;
        // No closing </redacted_thinking> tag — extractThinking() returns
        // null, so this lands in subagentRetryHandler's branch that never
        // increments thinkRetryCount and never escalates on its own.
        const text =
          "<redacted_thinking>\nSetup commands: none\nVerify commands: none\nOff-limits (run-project): none\naction: read_file\nrisk: still deciding\n";
        for (const character of text) {
          yield character;
        }
      },
    } as unknown as IOllamaClient;

    const subagent = makeSubagent(ollama, textModeConfig);
    const result = await subagent.run(baseRunParams(() => {}));

    expect(callCount).toBe(8);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no progress/i);
  });

  it("trips after 8 turns when the model repeatedly names an unregistered tool (native mode)", async () => {
    let callCount = 0;
    const ollama = {
      chatWithTools: async () => {
        callCount += 1;
        return {
          content: closedThink("action: frobnicate\nrisk: none"),
          toolCalls: [{ name: "frobnicate", args: {} }],
        };
      },
    } as unknown as IOllamaClient;

    const subagent = makeSubagent(ollama, nativeConfig);
    const result = await subagent.run(baseRunParams(() => {}));

    expect(callCount).toBe(8);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no progress/i);
  });

  it("trips after 8 turns when finish is repeatedly rejected for missing setup commands", async () => {
    let callCount = 0;
    const ollama = {
      chatWithTools: async () => {
        callCount += 1;
        return {
          content: closedThink("action: finish\nrisk: none"),
          toolCalls: [{ name: "finish", args: { summary: "done" } }],
        };
      },
    } as unknown as IOllamaClient;

    const subagent = makeSubagent(ollama, nativeConfig);
    const result = await subagent.run(
      baseRunParams(() => {}, { commandPlan: commandPlanWithSetup() }),
    );

    expect(callCount).toBe(8);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no progress/i);
  });

  it("does not trip across many genuinely productive turns (no false positive)", async () => {
    let callCount = 0;
    const totalReads = 12;
    const ollama = {
      chatWithTools: async () => {
        callCount += 1;
        if (callCount <= totalReads) {
          return {
            content: closedThink(`action: read_file file-${callCount}.ts\nrisk: none`),
            toolCalls: [{ name: "read_file", args: { path: `file-${callCount}.ts` } }],
          };
        }
        return {
          content: closedThink("action: finish\nrisk: none"),
          toolCalls: [{ name: "finish", args: { summary: "done" } }],
        };
      },
    } as unknown as IOllamaClient;

    const subagent = makeSubagent(ollama, nativeConfig);
    const result = await subagent.run(
      baseRunParams(() => {}, { workspace: fakeReadOnlyWorkspace() }),
    );

    expect(result.ok).toBe(true);
    expect(callCount).toBe(totalReads + 1);
  });
});

describe("Subagent think-block tool-call recovery (wiring)", () => {
  it("recovers read_file from a bare action line and completes via finish", async () => {
    let callCount = 0;
    const ollama = {
      chatStream: async function* (): AsyncGenerator<string> {
        callCount += 1;
        const text =
          callCount === 1
            ? closedThink(
                "action: read_file\nrisk: I need to see the content of src/App.tsx before adding the clock.",
              )
            : `${closedThink("action: finish\nrisk: none")}\n<<TOOL>>{"tool":"finish","summary":"done"}<<END>>`;
        for (const character of text) {
          yield character;
        }
      },
    } as unknown as IOllamaClient;

    const workspace = fakeReadOnlyWorkspace();
    const subagent = makeSubagent(ollama, textModeConfig);
    const result = await subagent.run(baseRunParams(() => {}, { workspace }));

    expect(workspace.readFile).toHaveBeenCalledWith(
      "src/App.tsx",
      expect.anything(),
    );
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  it("never synthesizes write_file from a think block — the breaker trips instead", async () => {
    let callCount = 0;
    const ollama = {
      chatStream: async function* (): AsyncGenerator<string> {
        callCount += 1;
        const text = closedThink(
          "action: write_file\nrisk: need to update src/App.tsx with the new clock component.",
        );
        for (const character of text) {
          yield character;
        }
      },
    } as unknown as IOllamaClient;

    const workspace = fakeReadOnlyWorkspace();
    const subagent = makeSubagent(ollama, textModeConfig, fakeAdvisingAgent());
    const result = await subagent.run(
      baseRunParams(() => {}, { workspace, recorder: fakeEscalationRecorder() }),
    );

    expect(workspace.writeFile).not.toHaveBeenCalled();
    expect(callCount).toBe(8);
    expect(result.ok).toBe(false);
  });
});
