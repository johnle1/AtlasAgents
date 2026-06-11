/**
 * <Summary>
 * What it does:
 *   Wraps the advisor Ollama role for planning (DAG JSON), blocking guidance
 *   when agents escalate, and streaming synthesis of multi-subtask results.
 *
 * How it fits in the system:
 *   Injected into AdvisorOrchestrator and Agent; never touches RSocket or TCP.
 *
 * Dependencies:
 *   - IOllamaClient — chat and chatStream.
 *   - IConfigManager — advisor model and temperature.
 *
 * Dependants:
 *   - AdvisorOrchestrator — plan and combine.
 *   - Agent — advise on ESCALATE.
 * </Summary>
 */

import type { IConfigManager, IOllamaClient } from "./interfaces.js";
import type {
  AdvisorPlan,
  Message,
  PlannedSubtask,
  SubtaskResult,
} from "./types.js";

const PLANNING_INSTRUCTION = `You must output ONLY valid JSON (no markdown fences, no commentary) with this exact shape:
{"subtasks":[{"id":1,"text":"string describing one actionable subtask","dependsOn":[]}]}

Rules:
- "id" must be a unique positive integer for each subtask.
- "text" must be a clear imperative instruction for a worker agent.
- "dependsOn" is an array of integer ids that must complete before this subtask runs. Use [] for tasks that can start immediately. Parallel work: give the same dependsOn (e.g. []) so they can run in one wave. Sequential work: later ids list earlier ids they need.
- Decompose the user's task into as many subtasks as needed (at least one).
- Do not include any keys other than "subtasks" at the top level.`;

/**
 * <Summary>
 * What it does:
 *   Strips optional markdown fences and extracts the outermost JSON object substring.
 *
 * Parameters:
 *   @param {string} raw — Raw model output possibly containing prose or fences.
 *
 * Returns:
 *   @returns {string} — Candidate JSON object string for JSON.parse.
 *
 * Dependencies:
 *   None.
 *
 * Dependants:
 *   - Advisor.plan — pre-parse normalisation before JSON.parse.
 * </Summary>
 */
const extractJsonObject = (raw: string): string => {
  const trimmed = raw.trim();
  // Step 1: models often wrap JSON in ``` or ```json fences — peel that off first.
  const fence = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/i.exec(trimmed);
  if (fence) {
    return fence[1].trim();
  }
  // Step 2: otherwise take the substring from first "{" to last "}" (ignores leading prose).
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  // Step 3: fallback — hope the whole string is pure JSON.
  return trimmed;
};

/**
 * <Summary>
 * What it does:
 *   Validates parsed JSON and returns a typed AdvisorPlan or throws.
 *
 * Parameters:
 *   @param {unknown} parsed — Result of JSON.parse.
 *
 * Returns:
 *   @returns {AdvisorPlan} — Normalised plan with sorted subtasks by id.
 *
 * @throws {Error} — When shape, ids, or dependency references are invalid.
 *
 * Dependencies:
 *   None.
 *
 * Dependants:
 *   - Advisor.plan — after JSON.parse on model output.
 * </Summary>
 */
const normaliseAdvisorPlan = (parsed: unknown): AdvisorPlan => {
  // Step 1: top-level must be an object with a "subtasks" array (anything else is unusable).
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("subtasks" in parsed) ||
    !Array.isArray((parsed as { subtasks: unknown }).subtasks)
  ) {
    throw new Error("Advisor returned invalid plan JSON");
  }
  const rawList = (parsed as { subtasks: unknown[] }).subtasks;
  // Step 2: orchestrator needs at least one subtask to run.
  if (rawList.length === 0) {
    throw new Error("Advisor returned invalid plan JSON");
  }
  const idSet = new Set<number>();
  const subtasks: PlannedSubtask[] = [];
  // Step 3: validate each array element — shape, types, uniqueness, non-empty text.
  for (const item of rawList) {
    if (typeof item !== "object" || item === null) {
      throw new Error("Advisor returned invalid plan JSON");
    }
    const o = item as Record<string, unknown>;
    // id must be a positive integer (floats / strings / zero rejected via NaN).
    const id =
      typeof o.id === "number" && Number.isInteger(o.id) && o.id > 0
        ? o.id
        : NaN;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    // dependsOn defaults to [] if missing or wrong type; entries must all be integers.
    const dependsOn = Array.isArray(o.dependsOn)
      ? o.dependsOn.map((d) =>
          typeof d === "number" && Number.isInteger(d) ? d : NaN,
        )
      : [];
    if (!Number.isFinite(id) || idSet.has(id) || text.length === 0) {
      throw new Error("Advisor returned invalid plan JSON");
    }
    if (dependsOn.some((d) => !Number.isFinite(d))) {
      throw new Error("Advisor returned invalid plan JSON");
    }
    idSet.add(id);
    subtasks.push({ id, text, dependsOn });
  }
  // Step 4: every dependency id must exist on some subtask, and must not point at itself.
  for (const s of subtasks) {
    for (const dep of s.dependsOn) {
      if (!idSet.has(dep)) {
        throw new Error("Advisor returned invalid plan JSON");
      }
      if (dep === s.id) {
        throw new Error("Advisor returned invalid plan JSON");
      }
    }
  }
  // Step 5: stable order for logging / combine — execution order still comes from dependsOn + waves.
  subtasks.sort((a, b) => a.id - b.id);
  return { subtasks };
};

export class Advisor {
  /**
   * @param {{ ollama: IOllamaClient; config: IConfigManager }} deps — Collaborators for model IO and settings.
   */
  constructor(
    private readonly deps: { ollama: IOllamaClient; config: IConfigManager },
  ) {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Produces a validated Directed Acyclic Graph(DAG) of subtasks as strict JSON from one blocking Ollama call.
   *
   * How it does it (step by step):
   *   1. Reads advisor model and temperature from IConfigManager.
   *   2. Builds system text: skill content, memory context header, then PLANNING_INSTRUCTION.
   *   3. Sends user message with the original task text.
   *   4. Parses JSON from the reply, normalises and validates subtasks and dependsOn.
   *
   * Parameters:
   *   @param {string} task — Original user task string.
   *   @param {string} contextHeader — Memory context block (may be empty).
   *   @param {string} skillContent — Selected skill file body (may be empty).
   *
   * Returns:
   *   @returns {Promise<AdvisorPlan>} — Executable subtask DAG.
   *
   * @throws {Error} — When JSON is missing or invalid (message includes invalid plan).
   *
   * Dependencies:
   *   - IConfigManager.getAdvisorModel, getAdvisorTemperature — model settings.
   *   - IOllamaClient.chat — blocking completion.
   *   - extractJsonObject, normaliseAdvisorPlan — parse pipeline.
   *
   * Dependants:
   *   - AdvisorOrchestrator.runTask — first decomposition step.
   * </Summary>
   */
  plan = async (
    task: string,
    contextHeader: string,
    skillContent: string,
  ): Promise<AdvisorPlan> => {
    // Load which model and how "creative" the planner should be.
    const model = await this.deps.config.getAdvisorModel();
    const temperature = await this.deps.config.getAdvisorTemperature();
    // System prompt: skill first, then memory context, then strict JSON rules (order matches the architecture spec).
    const systemParts: string[] = [];
    if (skillContent.trim().length > 0) {
      systemParts.push(skillContent.trim());
    }
    if (contextHeader.trim().length > 0) {
      systemParts.push(contextHeader.trim());
    }
    systemParts.push(PLANNING_INSTRUCTION);
    const system = systemParts.join("\n\n");
    const messages: Message[] = [
      { role: "system", content: system },
      { role: "user", content: task },
    ];
    // One blocking completion — we need the full plan before spawning agents.
    const raw = await this.deps.ollama.chat(model, messages, { temperature });
    let parsed: unknown;
    try {
      // Strip fences / prose, then parse; invalid JSON string → catch below.
      parsed = JSON.parse(extractJsonObject(raw));
    } catch {
      throw new Error("Advisor returned invalid plan JSON");
    }
    // Enforce schema + DAG invariants so the orchestrator never sees garbage.
    return normaliseAdvisorPlan(parsed);
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Returns a short natural-language hint for an agent that escalated with ESCALATE.
   *
   * How it does it (step by step):
   *   1. Reads advisor model and temperature from config.
   *   2. Serialises message history into a readable transcript for the prompt.
   *   3. Calls blocking Ollama chat with task, reason, and transcript.
   *
   * Parameters:
   *   @param {string} subtask — The subtask the agent was executing.
   *   @param {string} reason — Text after the ESCALATE: prefix.
   *   @param {Message[]} history — Conversation turns built by the agent so far.
   *
   * Returns:
   *   @returns {Promise<string>} — Guidance to append as a new user turn.
   *
   * Dependencies:
   *   - IConfigManager.getAdvisorModel, getAdvisorTemperature.
   *   - IOllamaClient.chat.
   *
   * Dependants:
   *   - Agent.run — escalation loop.
   * </Summary>
   */
  advise = async (
    subtask: string,
    reason: string,
    history: Message[],
  ): Promise<string> => {
    const model = await this.deps.config.getAdvisorModel();
    const temperature = await this.deps.config.getAdvisorTemperature();
    // Flatten the agent's message list so the advisor sees the whole attempt in one user blob.
    const transcript = history
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");
    const userContent = `The agent is stuck on this subtask:\n${subtask}\n\nReason for escalation:\n${reason}\n\nConversation so far:\n${transcript}\n\nReply with concise actionable guidance for the agent's next attempt. Do not repeat the ESCALATE protocol.`;
    const messages: Message[] = [
      {
        role: "system",
        content:
          "You are a senior technical advisor helping a coding agent unblock. Be direct and specific.",
      },
      { role: "user", content: userContent },
    ];
    // Blocking: the agent waits on this before appending guidance and retrying chatStream.
    return this.deps.ollama.chat(model, messages, { temperature });
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Streams a final user-facing answer that merges the original task with all subtask results.
   *
   * How it does it (step by step):
   *   1. Reads advisor model from config (combine uses same model as planning).
   *   2. Builds a user message listing each subtask id and its result body.
   *   3. Streams Ollama chat tokens and yields each chunk to the caller.
   *
   * Parameters:
   *   @param {string} originalTask — User's top-level task string.
   *   @param {SubtaskResult[]} results — Completed subtask outputs in display order.
   *
   * Returns:
   *   @returns {AsyncGenerator<string>} — Token strings for the client stream.
   *
   * Dependencies:
   *   - IConfigManager.getAdvisorModel, getAdvisorTemperature.
   *   - IOllamaClient.chatStream.
   *
   * Dependants:
   *   - AdvisorOrchestrator.runTask — multi-subtask completion path.
   * </Summary>
   */
  async *combine(
    originalTask: string,
    results: SubtaskResult[],
  ): AsyncGenerator<string> {
    const model = await this.deps.config.getAdvisorModel();
    const temperature = await this.deps.config.getAdvisorTemperature();
    // One section per completed subtask so the model can merge / dedupe / summarise.
    const resultsBlock = results
      .map((r) => `### Subtask ${r.id}\n${r.content}`)
      .join("\n\n");
    const userContent = `Original task:\n${originalTask}\n\nSubtask results:\n${resultsBlock}\n\nWrite one coherent final answer for the user that integrates the results. Do not mention internal subtask ids unless helpful.`;
    const messages: Message[] = [
      {
        role: "system",
        content:
          "You are the lead assistant delivering the final response to the user based on prior sub-work.",
      },
      { role: "user", content: userContent },
    ];
    // Stream tokens out — AdvisorOrchestrator forwards these to the client as the only visible output when N>1 subtasks.
    for await (const token of this.deps.ollama.chatStream(model, messages, {
      temperature,
    })) {
      yield token;
    }
  }
}
