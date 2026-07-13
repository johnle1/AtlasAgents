/**
 * Unit tests — spinnerSync.ts
 *
 * Tests `spinnerForStatusFrame` — the function that maps incoming server
 * task-status frames to the bottom-line CLI spinner state (or clears it).
 *
 * Testing pyramid layer : Unit
 * Runner                 : Vitest
 * Mocks                  : none (pure function, no I/O)
 *
 * Return value semantics (from the source):
 *   SpinnerState  → show this spinner configuration
 *   null          → hide / clear the spinner
 *   undefined     → leave the current spinner unchanged
 *
 * Category checklist:
 *   ✅ Normal  — every ADVISOR_THINKING_STAGES member, agent working stages
 *   ✅ Boundary — frames from non-status kinds, advisor ready, activity-less agent
 *   ✅ Error   — non-status frames must NEVER accidentally clear/set the spinner
 */

import { describe, expect, it } from "vitest";
import type {
  AdvisorStage,
  AgentStage,
  TaskFrame,
} from "../../packages/client/src/frames";
import { spinnerForStatusFrame } from "../../packages/client/src/ui/spinnerSync";

// ---------------------------------------------------------------------------
// Helpers — build strongly-typed TaskFrame fixtures
// ---------------------------------------------------------------------------

/**
 * Builds an advisor status frame.
 *
 * @param stage - The advisor pipeline stage.
 * @param icon - The status icon (◌ = in-progress, ✓ = done, ⚠ = warning).
 * @param message - Optional human-readable status message.
 */
const makeAdvisorFrame = (
  stage: AdvisorStage,
  icon: "◌" | "✓" | "⚠",
  message = "",
): TaskFrame => ({
  kind: "status",
  source: "advisor",
  stage,
  icon,
  message,
});

/**
 * Builds an agent status frame.
 *
 * @param stage - The agent lifecycle stage.
 * @param icon - Status icon.
 * @param activity - Optional in-flight activity details.
 */
const makeAgentFrame = (
  stage: AgentStage,
  icon: "◌" | "✓" | "⚠" = "◌",
  activity?: { stage: AgentStage; message: string },
): TaskFrame => ({
  kind: "status",
  source: { agentId: 1, agentLabel: "worker" },
  stage,
  icon,
  message: "",
  activity,
});

// ---------------------------------------------------------------------------
// Advisor — ADVISOR_THINKING_STAGES with ◌ icon → "thinking" spinner
// These six stages are explicitly listed in spinnerSync.ts.
// Each one must produce a thinking spinner when paired with the ◌ icon.
// ---------------------------------------------------------------------------

describe("spinnerForStatusFrame — advisor thinking stages (◌ icon)", () => {
  const thinkingStages: AdvisorStage[] = [
    "understanding",
    "reading-context",
    "drafting",
    "verifying",
    "revising",
    "combining",
  ];

  for (const stage of thinkingStages) {
    it(`returns thinking spinner for advisor stage '${stage}' with ◌ (normal)`, () => {
      const result = spinnerForStatusFrame(makeAdvisorFrame(stage, "◌"));
      expect(result).toEqual({ active: true, label: "Advisor", mode: "thinking" });
    });
  }
});

describe("spinnerForStatusFrame — advisor thinking stages with non-◌ icon", () => {
  it("returns undefined for 'understanding' with ✓ icon (boundary — wrong icon)", () => {
    // ADVISOR_THINKING_STAGES + ✓ does not match the ◌ guard → falls through to undefined
    const result = spinnerForStatusFrame(makeAdvisorFrame("understanding", "✓"));
    expect(result).toBeUndefined();
  });

  it("returns undefined for 'drafting' with ⚠ icon (boundary)", () => {
    const result = spinnerForStatusFrame(makeAdvisorFrame("drafting", "⚠"));
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Advisor — 'ready' stage always clears the spinner regardless of icon
// ---------------------------------------------------------------------------

describe("spinnerForStatusFrame — advisor 'ready' stage", () => {
  it("returns null (clear) for 'ready' with ✓ icon (normal — task complete)", () => {
    expect(spinnerForStatusFrame(makeAdvisorFrame("ready", "✓"))).toBeNull();
  });

  it("returns null (clear) for 'ready' with ◌ icon (boundary — supervising pool)", () => {
    // The 'ready' guard runs before the ◌ thinking guard,
    // so even ◌ + ready should clear the spinner.
    expect(spinnerForStatusFrame(makeAdvisorFrame("ready", "◌"))).toBeNull();
  });

  it("returns null (clear) for 'ready' with ⚠ icon (boundary)", () => {
    expect(spinnerForStatusFrame(makeAdvisorFrame("ready", "⚠"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Agent — activity.stage = 'thinking' takes highest priority
// ---------------------------------------------------------------------------

describe("spinnerForStatusFrame — agent with thinking activity", () => {
  it("returns thinking spinner when activity.stage is 'thinking' (normal)", () => {
    const result = spinnerForStatusFrame(
      makeAgentFrame("running", "◌", { stage: "thinking", message: "Planning next step" }),
    );
    expect(result).toEqual({ active: true, label: "Agent", mode: "thinking" });
  });

  it("returns thinking spinner even if outer stage is 'reading' but activity.stage='thinking' (boundary)", () => {
    // The activity guard fires first, so the outer stage is irrelevant here
    const result = spinnerForStatusFrame(
      makeAgentFrame("reading", "◌", { stage: "thinking", message: "Analyzing…" }),
    );
    expect(result).toEqual({ active: true, label: "Agent", mode: "thinking" });
  });
});

// ---------------------------------------------------------------------------
// Agent — top-level stage = 'thinking'
// ---------------------------------------------------------------------------

describe("spinnerForStatusFrame — agent stage = 'thinking' (no activity)", () => {
  it("returns thinking spinner for direct 'thinking' stage (normal)", () => {
    const result = spinnerForStatusFrame(makeAgentFrame("thinking"));
    expect(result).toEqual({ active: true, label: "Agent", mode: "thinking" });
  });
});

// ---------------------------------------------------------------------------
// Agent — working activity (non-thinking) → "working" spinner with message
// ---------------------------------------------------------------------------

describe("spinnerForStatusFrame — agent with working activity", () => {
  it("returns working spinner for 'reading' activity with a file path message (normal)", () => {
    const result = spinnerForStatusFrame(
      makeAgentFrame("reading", "◌", { stage: "reading", message: "Reading src/App.tsx…" }),
    );
    expect(result).toEqual({
      active: true,
      label: "Reading src/App.tsx…",
      mode: "working",
    });
  });

  it("returns working spinner for 'writing' activity (normal)", () => {
    const result = spinnerForStatusFrame(
      makeAgentFrame("writing", "◌", { stage: "writing", message: "Writing tests/unit.ts" }),
    );
    expect(result).toEqual({
      active: true,
      label: "Writing tests/unit.ts",
      mode: "working",
    });
  });

  it("returns working spinner for 'running' activity (shell execution) (normal)", () => {
    const result = spinnerForStatusFrame(
      makeAgentFrame("running", "◌", { stage: "running", message: "npm run build" }),
    );
    expect(result).toEqual({
      active: true,
      label: "npm run build",
      mode: "working",
    });
  });

  it("does not show a spinner for escalating activity (normal)", () => {
    const result = spinnerForStatusFrame(
      makeAgentFrame("escalating", "⚠", {
        stage: "escalating",
        message: "Escalating to advisor...",
      }),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Agent — no activity present → clear the spinner
// ---------------------------------------------------------------------------

describe("spinnerForStatusFrame — agent with no activity", () => {
  it("returns null (clear) for agent 'running' stage with no activity (normal)", () => {
    // No activity object means the agent has finished all granular steps
    expect(spinnerForStatusFrame(makeAgentFrame("running"))).toBeNull();
  });

  it("returns null (clear) for agent 'done' stage (boundary)", () => {
    expect(spinnerForStatusFrame(makeAgentFrame("done", "✓"))).toBeNull();
  });

  it("returns null (clear) for agent 'waiting' stage (boundary)", () => {
    expect(spinnerForStatusFrame(makeAgentFrame("waiting"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Non-status frames — MUST return undefined (leave spinner unchanged)
// ---------------------------------------------------------------------------

describe("spinnerForStatusFrame — non-status frames (boundary)", () => {
  it("returns undefined for a 'token' frame (boundary)", () => {
    const frame: TaskFrame = { kind: "token", text: "Hello" };
    expect(spinnerForStatusFrame(frame)).toBeUndefined();
  });

  it("returns undefined for a 'think' frame (boundary)", () => {
    const frame: TaskFrame = { kind: "think", text: "reasoning…", advisor: true };
    expect(spinnerForStatusFrame(frame)).toBeUndefined();
  });

  it("returns undefined for a 'done' frame (boundary)", () => {
    const frame: TaskFrame = { kind: "done" };
    expect(spinnerForStatusFrame(frame)).toBeUndefined();
  });

  it("returns undefined for an 'error' frame (boundary)", () => {
    const frame: TaskFrame = { kind: "error", message: "Something went wrong" };
    expect(spinnerForStatusFrame(frame)).toBeUndefined();
  });

  it("returns undefined for a 'progress' frame (boundary)", () => {
    const frame: TaskFrame = { kind: "progress", data: { status: "downloading", completed: 50, total: 100 } };
    expect(spinnerForStatusFrame(frame)).toBeUndefined();
  });
});
