/**
 * Integration tests — spinner + bridge wiring
 *
 * Verifies that `spinnerForStatusFrame` (the logic layer) integrates
 * correctly with the bridge's `setSpinner` and `setAgentStatus` /
 * `removeAgentStatus` dispatch layer.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : spinnerSync + bridge/agentStatus + bridge/state
 * Mocks                  : NONE — we test real wiring.
 *   The bridge hook callbacks themselves are plain `vi.fn()` stubs that
 *   stand in for the React context callbacks registered at runtime.
 *   This is the correct boundary: mock at the outermost layer (the UI
 *   context), not inside the module chain being tested.
 *
 * What integration tests catch that unit tests miss
 * -------------------------------------------------
 *   - `spinnerForStatusFrame` produces a value, but does that value
 *     reach the hook callback in the expected shape?
 *   - Does `setSpinner(null)` actually call `onSpinner(null)` — i.e. is
 *     the null handled correctly and not swallowed?
 *   - Do sequential frames update the hook in the correct order?
 *   - Does `clearAgentStatuses` call BOTH `onAgentStatuses` and
 *     `onAgentBoards` as documented?
 *
 * Category checklist:
 *   ✅ Happy path         — frames produce the expected hook calls
 *   ✅ System-level edges — null clear, undefined passthrough, order
 *   ✅ Failure propagation — non-status frames must NOT invoke the spinner hook
 *   ✅ Contract consistency — the SpinnerState shape matches bridge expectations
 *   ✅ State integrity     — multi-frame sequences leave state consistent
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskFrame } from "../../packages/client/src/frames";
import type { AgentBoardState } from "../../packages/client/src/ui/types";
import {
  clearAgentBoards,
  clearAgentStatuses,
  removeAgentStatus,
  setAgentBoards,
  setAgentStatus,
  setSpinner,
  updateAgentActivity,
} from "../../packages/client/src/ui/bridge/agentStatus";
import {
  getBridgeHooks,
  setBridgeHooks,
  setInkUIActiveValue,
  setTaskActiveValue,
} from "../../packages/client/src/ui/bridge/state";
import { spinnerForStatusFrame } from "../../packages/client/src/ui/spinnerSync";

// ---------------------------------------------------------------------------
// Shared test fixture builders
// ---------------------------------------------------------------------------

const advisorFrame = (
  stage: "understanding" | "drafting" | "ready" | "combining",
  icon: "◌" | "✓" | "⚠" = "◌",
): TaskFrame => ({
  kind: "status",
  source: "advisor",
  stage,
  icon,
  message: "",
});

const agentFrame = (
  stage: "thinking" | "running" | "reading" | "done",
  activity?: { stage: "thinking" | "reading" | "running"; message: string },
): TaskFrame => ({
  kind: "status",
  source: { agentId: 1, agentLabel: "Agent 1" },
  stage,
  icon: "◌",
  message: "",
  activity,
});

// ---------------------------------------------------------------------------
// Setup / teardown — wire mock hooks and reset state before each test
// ---------------------------------------------------------------------------

let mockHooks: {
  onSpinner: ReturnType<typeof vi.fn>;
  onAgentStatuses: ReturnType<typeof vi.fn>;
  onAgentBoards: ReturnType<typeof vi.fn>;
  onBusy: ReturnType<typeof vi.fn>;
  onTaskActive: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  // Create fresh spy functions for each test
  mockHooks = {
    onSpinner: vi.fn(),
    onAgentStatuses: vi.fn(),
    onAgentBoards: vi.fn(),
    onBusy: vi.fn(),
    onTaskActive: vi.fn(),
  };
  setBridgeHooks(mockHooks);
  setInkUIActiveValue(true);
  setTaskActiveValue(false);
});

afterEach(() => {
  // Restore clean state so tests don't bleed into each other
  setBridgeHooks({});
  setInkUIActiveValue(false);
  setTaskActiveValue(false);
});

// ---------------------------------------------------------------------------
// Happy path — frame → spinnerForStatusFrame → setSpinner → onSpinner hook
// ---------------------------------------------------------------------------

describe("Spinner pipeline — happy path", () => {
  it("advisor thinking frame fires onSpinner with a thinking SpinnerState (happy path)", () => {
    // Step 1: compute the spinner value from the incoming frame
    const spinnerValue = spinnerForStatusFrame(advisorFrame("understanding", "◌"));

    // Step 2: push the value through the bridge dispatch
    // (The real orchestrator does exactly this in taskStream.ts)
    if (spinnerValue !== undefined) {
      setSpinner(spinnerValue);
    }

    // Step 3: assert that the hook received the correct shape
    expect(mockHooks.onSpinner).toHaveBeenCalledOnce();
    expect(mockHooks.onSpinner).toHaveBeenCalledWith({
      active: true,
      label: "Advisor",
      mode: "thinking",
    });
  });

  it("advisor 'ready' frame fires onSpinner with null to clear the spinner (happy path)", () => {
    const spinnerValue = spinnerForStatusFrame(advisorFrame("ready", "✓"));
    // spinnerForStatusFrame returns null for 'ready' → clear the spinner
    if (spinnerValue !== undefined) {
      setSpinner(spinnerValue);
    }
    expect(mockHooks.onSpinner).toHaveBeenCalledWith(null);
  });

  it("agent thinking stage fires onSpinner with Agent thinking spinner (happy path)", () => {
    const spinnerValue = spinnerForStatusFrame(agentFrame("thinking"));
    if (spinnerValue !== undefined) {
      setSpinner(spinnerValue);
    }
    expect(mockHooks.onSpinner).toHaveBeenCalledWith({
      active: true,
      label: "Agent",
      mode: "thinking",
    });
  });

  it("agent reading activity fires onSpinner with working spinner and file path label (happy path)", () => {
    const spinnerValue = spinnerForStatusFrame(
      agentFrame("reading", { stage: "reading", message: "Reading src/utils.ts" }),
    );
    if (spinnerValue !== undefined) {
      setSpinner(spinnerValue);
    }
    expect(mockHooks.onSpinner).toHaveBeenCalledWith({
      active: true,
      label: "Reading src/utils.ts",
      mode: "working",
    });
  });
});

// ---------------------------------------------------------------------------
// System-level edge — non-status frames must NOT touch the spinner hook
// ---------------------------------------------------------------------------

describe("Spinner pipeline — non-status frame passthrough", () => {
  it("'token' frame leaves spinner unchanged — onSpinner is NOT called (edge)", () => {
    const tokenFrame: TaskFrame = { kind: "token", text: "Hello world" };
    const spinnerValue = spinnerForStatusFrame(tokenFrame);

    // spinnerForStatusFrame returns undefined for non-status frames
    expect(spinnerValue).toBeUndefined();

    // The undefined return means: "do not update spinner" — so we must NOT
    // call setSpinner at all in this case.
    if (spinnerValue !== undefined) {
      setSpinner(spinnerValue); // this branch should NOT execute
    }

    expect(mockHooks.onSpinner).not.toHaveBeenCalled();
  });

  it("'done' frame leaves spinner unchanged (edge)", () => {
    const doneFrame: TaskFrame = { kind: "done" };
    const spinnerValue = spinnerForStatusFrame(doneFrame);
    expect(spinnerValue).toBeUndefined();
    expect(mockHooks.onSpinner).not.toHaveBeenCalled();
  });

  it("'error' frame leaves spinner unchanged (edge)", () => {
    const errorFrame: TaskFrame = { kind: "error", message: "Ollama unreachable" };
    const spinnerValue = spinnerForStatusFrame(errorFrame);
    expect(spinnerValue).toBeUndefined();
    expect(mockHooks.onSpinner).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// State integrity — multi-frame sequences produce consistent hook call order
// ---------------------------------------------------------------------------

describe("Spinner pipeline — multi-frame sequence integrity", () => {
  it("advisor thinking → advisor ready produces: thinking spinner, then null (state integrity)", () => {
    // Simulate a realistic advisor run: thinking phase, then completion
    const frames: TaskFrame[] = [
      advisorFrame("drafting", "◌"),
      advisorFrame("combining", "◌"),
      advisorFrame("ready", "✓"),
    ];

    for (const frame of frames) {
      const spinnerValue = spinnerForStatusFrame(frame);
      if (spinnerValue !== undefined) {
        setSpinner(spinnerValue);
      }
    }

    // Should have two thinking calls + one null (clear)
    expect(mockHooks.onSpinner).toHaveBeenCalledTimes(3);

    const calls = mockHooks.onSpinner.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls[0]).toMatchObject({ mode: "thinking", label: "Advisor" });
    expect(calls[1]).toMatchObject({ mode: "thinking", label: "Advisor" });
    expect(calls[2]).toBeNull();
  });

  it("agent thinking → agent working → agent done produces correct sequence (state integrity)", () => {
    const frames: TaskFrame[] = [
      agentFrame("thinking"),
      agentFrame("reading", { stage: "reading", message: "Reading index.ts" }),
      agentFrame("done"),
    ];

    for (const frame of frames) {
      const spinnerValue = spinnerForStatusFrame(frame);
      if (spinnerValue !== undefined) {
        setSpinner(spinnerValue);
      }
    }

    const calls = mockHooks.onSpinner.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls[0]).toMatchObject({ mode: "thinking", label: "Agent" });
    expect(calls[1]).toMatchObject({ mode: "working" });
    expect(calls[2]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setAgentStatus / removeAgentStatus — contract consistency
// ---------------------------------------------------------------------------

describe("setAgentStatus / removeAgentStatus integration", () => {
  it("setAgentStatus invokes onAgentStatuses with an updater function (contract)", () => {
    setAgentStatus({ id: 1, label: "Agent 1", icon: "◌", message: "Thinking…" });
    expect(mockHooks.onAgentStatuses).toHaveBeenCalledOnce();
    // The updater should be a function (React dispatch pattern)
    expect(typeof mockHooks.onAgentStatuses.mock.calls[0]![0]).toBe("function");
  });

  it("setAgentStatus updater inserts the status into the map (contract)", () => {
    setAgentStatus({ id: 2, label: "Agent 2", icon: "✓", message: "Done" });
    // Simulate React calling the updater with the current state map
    const previousMap = new Map<number | "advisor", unknown>();
    const updater = mockHooks.onAgentStatuses.mock.calls[0]![0] as (
      m: Map<number | "advisor", unknown>,
    ) => Map<number | "advisor", unknown>;
    const newMap = updater(previousMap);
    expect(newMap.has(2)).toBe(true);
    expect(newMap.get(2)).toMatchObject({ label: "Agent 2", icon: "✓" });
  });

  it("removeAgentStatus updater deletes the agent from the map (contract)", () => {
    const initialMap = new Map<number | "advisor", unknown>([[
      3,
      { id: 3, label: "Agent 3", icon: "◌", message: "" },
    ]]);
    removeAgentStatus(3);
    const updater = mockHooks.onAgentStatuses.mock.calls[0]![0] as (
      m: Map<number | "advisor", unknown>,
    ) => Map<number | "advisor", unknown>;
    const newMap = updater(initialMap);
    expect(newMap.has(3)).toBe(false);
  });

  it("removeAgentStatus is a no-op when agent does not exist (edge — defensive)", () => {
    const initialMap = new Map<number | "advisor", unknown>();
    removeAgentStatus(99);
    const updater = mockHooks.onAgentStatuses.mock.calls[0]![0] as (
      m: Map<number | "advisor", unknown>,
    ) => Map<number | "advisor", unknown>;
    const newMap = updater(initialMap);
    // Should return the same map reference when the agent wasn't present
    expect(newMap).toBe(initialMap);
  });
});

// ---------------------------------------------------------------------------
// clearAgentStatuses — clears BOTH agent statuses AND agent boards
// ---------------------------------------------------------------------------

describe("clearAgentStatuses integration", () => {
  it("calls both onAgentStatuses and onAgentBoards (contract consistency)", () => {
    clearAgentStatuses();
    expect(mockHooks.onAgentStatuses).toHaveBeenCalledOnce();
    expect(mockHooks.onAgentBoards).toHaveBeenCalledOnce();
  });

  it("onAgentStatuses updater returns an empty Map (contract)", () => {
    clearAgentStatuses();
    const updater = mockHooks.onAgentStatuses.mock.calls[0]![0] as () => Map<unknown, unknown>;
    expect(updater()).toEqual(new Map());
  });

  it("onAgentBoards updater returns an empty array (contract)", () => {
    clearAgentStatuses();
    const boardUpdater = mockHooks.onAgentBoards.mock.calls[0]![0] as () => unknown[];
    expect(boardUpdater()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// setAgentBoards + updateAgentActivity — activity preservation contract
// ---------------------------------------------------------------------------

describe("setAgentBoards activity preservation", () => {
  it("preserves the previous activity when a task is still running (contract)", () => {
    const previousBoards: AgentBoardState[] = [
      {
        id: 1,
        label: "Agent 1",
        tasks: [{ id: 1, text: "Build", state: "running" }],
        activity: { stage: "reading", message: "Reading package.json" },
      },
    ];

    const newBoards: AgentBoardState[] = [
      {
        id: 1,
        label: "Agent 1",
        tasks: [{ id: 1, text: "Build", state: "running" }],
        // The new snapshot omits activity — server frame doesn't always include it
        activity: undefined,
      },
    ];

    setAgentBoards(newBoards);
    const boardUpdater = mockHooks.onAgentBoards.mock.calls[0]![0] as (
      prev: typeof previousBoards,
    ) => typeof previousBoards;
    const result = boardUpdater(previousBoards);

    // The running task should have its previous activity preserved
    expect(result[0]!.activity).toEqual({
      stage: "reading",
      message: "Reading package.json",
    });
  });

  it("clears activity when no task is running in the board (contract)", () => {
    const previousBoards: AgentBoardState[] = [
      {
        id: 1,
        label: "Agent 1",
        tasks: [{ id: 1, text: "Build", state: "complete" }],
        activity: { stage: "reading", message: "Old activity" },
      },
    ];

    const newBoards: AgentBoardState[] = [
      {
        id: 1,
        label: "Agent 1",
        tasks: [{ id: 1, text: "Build", state: "complete" }],
        activity: undefined,
      },
    ];

    setAgentBoards(newBoards);
    const boardUpdater = mockHooks.onAgentBoards.mock.calls[0]![0] as (
      prev: typeof previousBoards,
    ) => typeof previousBoards;
    const result = boardUpdater(previousBoards);

    // No running tasks → activity should be cleared (undefined)
    expect(result[0]!.activity).toBeUndefined();
  });
});

describe("updateAgentActivity", () => {
  it("updates the activity for the matching agent board (contract)", () => {
    const previousBoards: AgentBoardState[] = [
      {
        id: 1,
        label: "Agent 1",
        tasks: [{ id: 1, text: "Work", state: "running" }],
        activity: undefined,
      },
    ];

    const newActivity = { stage: "writing" as const, message: "Writing output.ts" };
    updateAgentActivity(1, newActivity);

    const updater = mockHooks.onAgentBoards.mock.calls[0]![0] as (
      prev: typeof previousBoards,
    ) => typeof previousBoards;
    const result = updater(previousBoards);
    expect(result[0]!.activity).toEqual(newActivity);
  });

  it("is a no-op when the agent board is not found (edge — missing agent)", () => {
    const previousBoards: AgentBoardState[] = [
      {
        id: 1,
        label: "Agent 1",
        tasks: [],
        activity: undefined,
      },
    ];

    updateAgentActivity(999, { stage: "reading" as const, message: "some file" });
    const updater = mockHooks.onAgentBoards.mock.calls[0]![0] as (
      prev: typeof previousBoards,
    ) => typeof previousBoards;
    const result = updater(previousBoards);
    // Should return the previous boards unchanged
    expect(result).toEqual(previousBoards);
  });
});
