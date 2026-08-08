/**
 * Shared test doubles for driving the real `Subagent.run()` loop.
 *
 * @remarks
 * Extracted from `subagentThinkStream.test.ts`, which has its own
 * module-private copies of these — left untouched to avoid any regression
 * risk to its passing suite. New subagent-loop tests (no-progress breaker,
 * think-block tool recovery) should import from here instead of duplicating
 * the setup again.
 */

import { vi } from "vitest";
import type { Agent } from "../../packages/server/src/orchestration/agent/agent.js";
import type {
  IConfigManager,
  IOllamaClient,
} from "../../packages/server/src/orchestration/interfaces.js";
import { Subagent } from "../../packages/server/src/orchestration/subagent/subagent.js";
import type { AgentRunParams } from "../../packages/server/src/orchestration/subagent/types.js";
import type { CommandPlan } from "../../packages/server/src/orchestration/types.js";
import type { TaskFrame } from "../../packages/server/src/transport/frames.js";

/** Config resolving to native Ollama tool-calling mode (`chatWithTools`). */
export const nativeConfig = {
  getSubagentModel: async () => "fake-subagent-model",
  getSubagentTemperature: async () => 0.4,
  getSubagentModelSupportsTools: async () => true,
  getMaxRetries: async () => 3,
} as unknown as IConfigManager;

/** Config resolving to legacy text-protocol mode (`chatStream` + `<<TOOL>>` blocks). */
export const textModeConfig = {
  getSubagentModel: async () => "fake-subagent-model",
  getSubagentTemperature: async () => 0.4,
  getSubagentModelSupportsTools: async () => false,
  getMaxRetries: async () => 3,
} as unknown as IConfigManager;

/**
 * Builds minimal `AgentRunParams`, matching the "finish"-only tool path's
 * needs — `finishHandler.ts` only reads `handlerContext.trackers`/`commandPlan`
 * (both built internally by `Subagent.run`) and never touches
 * workspace/terminal/recorder, so empty objects satisfy them by default.
 * Pass `workspace`/`commandPlan` explicitly for tests that exercise
 * `read_file` or the setup-command gate.
 */
export const baseRunParams = (
  emit: (frame: TaskFrame) => void,
  overrides: Partial<AgentRunParams> = {},
): AgentRunParams => ({
  taskId: "task-1",
  subtask: "do the thing",
  agentId: 1,
  agentLabel: "worker",
  skillContent: "",
  sessionContext: "",
  workspace: {},
  terminal: {},
  recorder: {},
  emit,
  signal: new AbortController().signal,
  ...overrides,
});

/** Constructs a `Subagent` wired to a fake Ollama client and the given config. */
export const makeSubagent = (
  ollama: IOllamaClient,
  config: IConfigManager = nativeConfig,
  agent: Agent = {} as unknown as Agent,
): Subagent => new Subagent({ ollama, config, agent });

/**
 * A lead-agent stub whose `advise()` resolves to fixed guidance — needed
 * whenever a test's fake model keeps failing long enough to exhaust the
 * subagent's retry budget and trigger real escalation (`escalateHandler.ts`
 * calls `agent.advise(...)`, which throws on the harness's default `{}` agent
 * stub if left unset).
 */
export const fakeAdvisingAgent = (guidance = "Try a different approach.") =>
  ({ advise: vi.fn(async () => guidance) }) as unknown as Agent;

/** A recorder stub with just `logEscalation` — required whenever a test drives real escalation. */
export const fakeEscalationRecorder = () => ({
  logEscalation: vi.fn(),
});

/**
 * A workspace stub whose `readFile` resolves to fixed content and `writeFile`
 * is a bare spy — both are `vi.fn()` so tests can assert on call args/counts
 * (e.g. "recovery called read_file with this exact path", "write_file was
 * never called").
 */
export const fakeReadOnlyWorkspace = (content = "file content") => ({
  readFile: vi.fn(async (_path: string) => content),
  writeFile: vi.fn(async () => {}),
});

/** A command plan with one setup command, never marked complete by these tests. */
export const commandPlanWithSetup = (): CommandPlan => ({
  setupCommands: ["npm install"],
  verifyCommands: [],
  runProjectCommands: [],
});
