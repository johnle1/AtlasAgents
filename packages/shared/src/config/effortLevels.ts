/**
 * How much the agent turn's REASON phase (`orchestration/agent/reasoner.ts`
 * on the server) re-deliberates before acting.
 *
 * @remarks
 * This buys re-deliberation, not persistence — the agent loop's own "keep
 * going until the task is done" behavior (the iteration ceiling and the
 * absence of any give-up-early counter) is unaffected by this setting at
 * every level, `low` included. Hitting a level's refinement cap means the
 * reasoner accepts its current decision and the loop acts on it — it never
 * means the turn gives up.
 *
 * Lives here (not in `packages/server/src/config/types.ts`, which
 * re-exports it) so the client's `/effort` picker and the server's config
 * validation share one literal list with no risk of drift.
 *
 * - `"low"` — REASON phase skipped entirely (1 model call per iteration,
 *   the pre-reasoner behavior, no refinement-round check at all).
 * - `"medium"` (default) — up to 1 refinement round, 1 finish-verification
 *   pass. Chosen as the default over `"high"` because the fixed per-step
 *   cost (the reasoning call plus the finish-verification pass) is overhead
 *   on every iteration even when the model converges instantly — `"high"`'s
 *   extra refinement headroom only pays off once a decision is already
 *   stuck looping, which isn't the common case.
 * - `"high"` — up to 2 refinement rounds, 2 finish-verification passes.
 * - `"extra-high"` — up to 4 refinement rounds, 2 finish-verification passes.
 * - `"max"` — up to 6 refinement rounds, 2 finish-verification passes (each
 *   of which may itself re-refine).
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "extra-high", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Type guard for narrowing an unknown/disk-read value against {@link EFFORT_LEVELS}. */
export const isEffortLevel = (value: unknown): value is EffortLevel =>
  typeof value === "string" &&
  (EFFORT_LEVELS as readonly string[]).includes(value);
