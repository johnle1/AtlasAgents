/**
 * <Summary>
 * What it does:
 *   Conducts one end-user task: memory context, skill selection, advisor DAG
 *   planning, parallel/sequential agent waves, optional combine stream, and
 *   experience recording.
 *
 * How it fits in the system:
 *   Intended RouterDeps.task implementation; transport-agnostic.
 *
 * Dependencies:
 *   - IContextBuilder, ISkillManager, IExperienceRecorder — memory and skills.
 *   - Advisor — plan and combine.
 *   - IOllamaClient, IConfigManager — forwarded into Agent instances.
 *   - Agent — per-subtask execution.
 *
 * Dependants:
 *   - Server bootstrap — new AdvisorOrchestrator(...).runTask wired to Router.task.
 * </Summary>
 */

import { randomUUID } from "node:crypto";

import { Agent } from "./agent.js";
import { Advisor } from "./advisor.js";
import type {
  IContextBuilder,
  IExperienceRecorder,
  IConfigManager,
  IOllamaClient,
  ISkillManager,
} from "./interfaces.js";
import type {
  AdvisorPlan,
  OrchestrationOutcome,
  PlannedSubtask,
  SessionInfo,
  SubtaskResult,
} from "./types.js";

/**
 * <Summary>
 * What it does:
 *   Formats completed dependency subtasks as context for the next agent system prompt.
 *
 * Parameters:
 *   @param {Map<number, string>} results — Finished subtask id to output text.
 *   @param {number[]} dependsOn — Prerequisite ids from the plan.
 *
 * Returns:
 *   @returns {string} — Markdown-ish block or empty when no deps.
 *
 * Dependencies:
 *   None.
 *
 * Dependants:
 *   - AdvisorOrchestrator.runTask — sessionContext argument to Agent.run.
 * </Summary>
 */
const buildSessionContext = (
  results: Map<number, string>,
  dependsOn: number[],
): string => {
  // Step 1: If this subtask has no dependencies, return empty string (no prior context needed)
  if (dependsOn.length === 0) {
    return "";
  }
  // Step 2: Sort dependency IDs numerically to ensure deterministic ordering
  const sorted = [...dependsOn].sort((a, b) => a - b);
  // Step 3: For each dependency ID, create a markdown block with the subtask output
  const blocks = sorted.map((id) => {
    const body = results.get(id) ?? "";
    return `### Prior subtask ${id}\n${body}`;
  });
  // Step 4: Join all blocks with double newlines and add leading spacing
  return `\n\n${blocks.join("\n\n")}`;
};

/**
 * <Summary>
 * What it does:
 *   Selects the next runnable wave: subtasks still pending whose dependsOn ids
 *   all have recorded results.
 *
 * Parameters:
 *   @param {Map<number, PlannedSubtask>} pending — Remaining subtasks keyed by id.
 *   @param {Map<number, string>} results — Completed subtask outputs keyed by id.
 *
 * Returns:
 *   @returns {PlannedSubtask[]} — Deterministic wave sorted by subtask id.
 *
 * Dependencies:
 *   None.
 *
 * Dependants:
 *   - AdvisorOrchestrator.runTask — DAG scheduler loop.
 * </Summary>
 */
const pickWave = (
  pending: Map<number, PlannedSubtask>,
  results: Map<number, string>,
): PlannedSubtask[] => {
  // Step 1: Initialize empty wave array to hold runnable subtasks
  const wave: PlannedSubtask[] = [];
  // Step 2: Iterate through all pending subtasks to check their dependencies
  for (const subtask of pending.values()) {
    // Step 3: Check if all prerequisite subtasks have completed (exist in results map)
    if (subtask.dependsOn.every((depId) => results.has(depId))) {
      // Step 4: Add subtask to wave if all dependencies are satisfied
      wave.push(subtask);
    }
  }
  // Step 5: Sort wave by subtask ID for deterministic execution order
  wave.sort((subtaskA, subtaskB) => subtaskA.id - subtaskB.id);
  // Step 6: Return the wave of runnable subtasks
  return wave;
};

/**
 * <Summary>
 * What it does:
 *   Maps a result map into ordered SubtaskResult rows following plan order.
 *
 * Parameters:
 *   @param {AdvisorPlan} plan — Advisor plan containing id list.
 *   @param {Map<number, string>} resultMap — Raw id to output text.
 *
 * Returns:
 *   @returns {SubtaskResult[]} — Ordered rows for combine and recording.
 *
 * Dependencies:
 *   None.
 *
 * Dependants:
 *   - AdvisorOrchestrator.runTask — outcome assembly.
 * </Summary>
 */
const toOrderedResults = (
  plan: AdvisorPlan,
  resultMap: Map<number, string>,
): SubtaskResult[] => {
  const sorted = [...plan.subtasks].sort((a, b) => a.id - b.id);
  return sorted.map((s) => ({
    id: s.id,
    content: resultMap.get(s.id) ?? "",
  }));
};

export class AdvisorOrchestrator {
  /**
   * @param {{ contextBuilder: IContextBuilder; skillManager: ISkillManager; experienceRecorder: IExperienceRecorder; advisor: Advisor; ollama: IOllamaClient; config: IConfigManager }} deps — Collaborators for one server process.
   */
  constructor(
    private readonly deps: {
      contextBuilder: IContextBuilder;
      skillManager: ISkillManager;
      experienceRecorder: IExperienceRecorder;
      advisor: Advisor;
      ollama: IOllamaClient;
      config: IConfigManager;
    },
  ) {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Runs the full advisor-agent pipeline for one natural-language task string.
   *
   * How it does it (step by step):
   *   1. Allocates taskId and calls experienceRecorder.start.
   *   2. Builds memory context and selects a skill document.
   *   3. Calls Advisor.plan to obtain a DAG of subtasks.
   *   4. Repeatedly picks waves of runnable subtasks, runs Agent instances in parallel inside each wave with no user-visible agent tokens.
   *   5. If exactly one subtask emits its result directly; else streams Advisor.combine.
   *   6. Always calls experienceRecorder.finish with OrchestrationOutcome.
   *
   * Parameters:
   *   @param {SessionInfo} session — Authenticated connection identity for future auditing.
   *   @param {string} taskText — User task description.
   *   @param {(token: string) => void} emit — User-visible token sink (combine or single result).
   *   @param {AbortSignal} signal — Cancels between waves or inside streams.
   *
   * Returns:
   *   @returns {Promise<void>} — Completes after finish and optional user emit.
   *
   * Dependencies:
   *   - IContextBuilder.build, ISkillManager.selectForTask.
   *   - IExperienceRecorder.start, finish.
   *   - Advisor.plan, Advisor.combine.
   *   - Agent.run, pickWave, buildSessionContext, toOrderedResults.
   *
   * Dependants:
   *   - Router.routeTask — when wired as TaskHandler adapter.
   * </Summary>
   */
  runTask = async (
    session: SessionInfo,
    taskText: string,
    emit: (token: string) => void,
    signal: AbortSignal,
  ): Promise<void> => {
    void session;
    const taskId = randomUUID();
    let plan: AdvisorPlan = { subtasks: [] };
    const resultMap = new Map<number, string>();
    let outcome: OrchestrationOutcome = {
      ok: false,
      plan,
      results: [],
      error: "not started",
    };

    const agent = new Agent({
      ollama: this.deps.ollama,
      config: this.deps.config,
      advisor: this.deps.advisor,
    });

    const noopEmit = (): void => {};

    try {
      if (signal.aborted) {
        throw new Error("Aborted");
      }

      const contextHeader = await this.deps.contextBuilder.build(taskText);
      const skill = await this.deps.skillManager.selectForTask(taskText);
      const skillBody = skill?.content ?? "";

      await this.deps.experienceRecorder.start(taskId, taskText);

      plan = await this.deps.advisor.plan(taskText, contextHeader, skillBody);

      const pending = new Map(plan.subtasks.map((s) => [s.id, s]));

      while (pending.size > 0) {
        if (signal.aborted) {
          throw new Error("Aborted");
        }
        const wave = pickWave(pending, resultMap);
        if (wave.length === 0) {
          throw new Error(
            "Deadlock: cyclic or invalid dependencies in advisor plan",
          );
        }

        const waveOutputs = await Promise.all(
          wave.map(async (st) => {
            const sessionContext = buildSessionContext(resultMap, st.dependsOn);
            const text = await agent.run(
              st.text,
              skillBody,
              sessionContext,
              noopEmit,
              signal,
            );
            return { id: st.id, text };
          }),
        );

        for (const row of waveOutputs) {
          resultMap.set(row.id, row.text);
          pending.delete(row.id);
        }
      }

      const ordered = toOrderedResults(plan, resultMap);

      if (plan.subtasks.length === 1) {
        emit(ordered[0]?.content ?? "");
      } else {
        for await (const token of this.deps.advisor.combine(
          taskText,
          ordered,
        )) {
          if (signal.aborted) {
            throw new Error("Aborted");
          }
          emit(token);
        }
      }

      outcome = { ok: true, plan, results: ordered };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = {
        ok: false,
        plan,
        results: toOrderedResults(plan, resultMap),
        error: message,
      };
      if (!signal.aborted && message !== "Aborted") {
        emit(`\n[orchestrator] ${message}\n`);
      }
    } finally {
      try {
        await this.deps.experienceRecorder.finish(taskId, outcome);
      } catch (finishErr) {
        console.error(
          "[AdvisorOrchestrator] experienceRecorder.finish failed:",
          finishErr,
        );
      }
    }
  };
}
