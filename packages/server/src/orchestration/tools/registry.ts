/**
 * Assembles and queries the set of tools available to a subagent run.
 *
 * @remarks
 * A "registry" here is just an ordered `ToolHandler[]` — the standard file
 * tools plus escalate/finish plus any dynamically-provided TokenSave (MCP)
 * tools for that run. This module builds that array once per run and
 * provides lookup helpers (schema list, name-keyed map) that the subagent
 * loop and prompt builder consume.
 */

import type { Agent } from "../agent/agent.js";
import type { ToolHandler, ToolSchema } from "./types.js";
import { readFileTool } from "./readFileHandler.js";
import { writeFileTool } from "./writeFileHandler.js";
import { editFileTool } from "./editFileHandler.js";
import { runCommandTool } from "./runCommandHandler.js";
import { createEscalateTool } from "./escalateHandler.js";
import { finishTool } from "./finishHandler.js";
import { createTokenSaveToolHandlers } from "./tokenSaveToolHandler.js";
import { updatePlanTool } from "./updatePlanHandler.js";
import { runStepsParallelTool } from "./runStepsParallelHandler.js";

/**
 * Builds the ordered list of tools available to a subagent for one run.
 *
 * @remarks
 * The standard toolset (read/write/edit file, run command, escalate, finish)
 * is always present. `extraTools` supplies TokenSave (MCP) tool schemas
 * discovered at connection time; each is wrapped into a handler via
 * {@link "./tokenSaveToolHandler.js".createTokenSaveToolHandlers | createTokenSaveToolHandlers}.
 * The `escalate` tool is built per-call since it closes over `agent` (needed
 * to request guidance from the lead agent).
 *
 * @param agent - The lead agent instance the escalate tool asks for guidance.
 * @param extraTools - Optional TokenSave tool schemas to include for this run.
 * @returns The full list of handlers this subagent can call.
 *
 * @example
 * ```ts
 * const registry = createToolRegistry(leadAgent, tokenSaveSchemas);
 * const schemas = getToolSchemas(registry); // pass to Ollama chatWithTools
 * ```
 */
export const createToolRegistry = (
  agent: Agent,
  extraTools: ToolSchema[] = [],
): ToolHandler[] => [
  readFileTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  createEscalateTool(agent),
  finishTool,
  ...createTokenSaveToolHandlers(extraTools),
];

/**
 * Extracts the JSON schemas from a tool registry for the model API.
 *
 * @param registry - The tool registry built by {@link createToolRegistry}.
 * @returns Schemas in the same order as the registry, ready to pass to
 *   Ollama's native tool-calling API or render into a text-mode prompt block.
 */
export const getToolSchemas = (registry: ToolHandler[]): ToolSchema[] =>
  registry.map((tool) => tool.schema);

/**
 * Builds the ordered list of tools available to the unified top-level agent
 * turn (see `agentTurn.ts`) for one task.
 *
 * @remarks
 * Distinct from {@link createToolRegistry} in two ways: it omits `escalate`
 * (there is no separate lead agent to escalate to — this loop IS the lead),
 * and it adds `update_plan` / `run_steps_parallel`, the two tools that let
 * the agent express a checklist and run independent steps concurrently.
 * `finish` is still included — it's what lets a multi-step turn end
 * explicitly (with its existing verify-before-finish gate), while a simple
 * conversational turn just ends when the model returns plain text with no
 * tool call at all. This registry is fully self-contained — the unified
 * agent turn never requires a subagent to be constructed; `run_steps_parallel`
 * completes each concurrent step through the same loop (see
 * {@link createWorkerToolRegistry}), not a separate persona.
 *
 * @param extraTools - Optional TokenSave (MCP) tool schemas to include for this run.
 * @returns The full list of handlers the unified agent turn can call.
 */
export const createAgentTurnToolRegistry = (
  extraTools: ToolSchema[] = [],
): ToolHandler[] => [
  readFileTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  updatePlanTool,
  runStepsParallelTool,
  finishTool,
  ...createTokenSaveToolHandlers(extraTools),
];

/**
 * Builds the ordered list of tools available to one concurrent step
 * dispatched by `run_steps_parallel`.
 *
 * @remarks
 * A step is completed by the same tool-calling loop as the top-level agent
 * turn, just with a narrower toolset: no `update_plan` (the checklist
 * belongs to the parent turn, not to one of its concurrent steps) and no
 * `run_steps_parallel` (steps don't recursively fan out further batches).
 * No `escalate` either, for the same reason as {@link createAgentTurnToolRegistry}.
 *
 * @param extraTools - Optional TokenSave (MCP) tool schemas to include for this run.
 * @returns The full list of handlers one concurrent step can call.
 */
export const createWorkerToolRegistry = (
  extraTools: ToolSchema[] = [],
): ToolHandler[] => [
  readFileTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  finishTool,
  ...createTokenSaveToolHandlers(extraTools),
];


/**
 * Indexes a tool registry by tool name for O(1) lookup during execution.
 *
 * @param registry - The tool registry built by {@link createToolRegistry}.
 * @returns A map from tool name (e.g. `"read_file"`) to its handler.
 */
export const getToolHandlerMap = (
  registry: ToolHandler[],
): Map<string, ToolHandler> =>
  new Map(registry.map((tool) => [tool.schema.function.name, tool]));

/**
 * Looks up a single tool's schema by name.
 *
 * @param registry - The tool registry built by {@link createToolRegistry}.
 * @param name - Tool name to find, e.g. `"finish"`.
 * @returns The matching schema, or `undefined` if no tool with that name is registered.
 */
export const getToolSchemaByName = (
  registry: ToolHandler[],
  name: string,
): ToolSchema | undefined =>
  registry.find((tool) => tool.schema.function.name === name)?.schema;
