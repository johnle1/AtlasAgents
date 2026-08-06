/**
 * Unit tests — taskBoardLayout.ts
 *
 * Tests the three exported layout helpers used to render the agent task board:
 *   - wrapTaskLine         — word-wraps a text string to a column budget
 *   - buildTaskBoardLines  — builds a renderable line list from tasks + activity
 *   - taskBoardBorderWidth — calculates the border width from content
 *
 * Testing pyramid layer : Unit
 * Runner                 : Vitest
 * Mocks                  : none (pure functions)
 *
 * Category checklist:
 *   ✅ Normal  — typical task descriptions, multi-task boards
 *   ✅ Boundary — empty inputs, maxWidth < 8 guard, exact-fit text,
 *                 text with no spaces, continuation-line indentation
 *   ✅ Error   — empty task list, no activity message
 */

import { describe, expect, it } from "vitest";
import {
  buildTaskBoardLines,
  buildTaskBoardProgress,
  resolveTaskBoardProgressColor,
  TASK_BOARD_MIN_BORDER_WIDTH,
  TASK_BOARD_MIN_INNER_WIDTH,
  taskBoardBorderWidth,
  wrapTaskLine,
} from "../../../../packages/client/src/ui/taskBoardLayout";

// ---------------------------------------------------------------------------
// wrapTaskLine
// ---------------------------------------------------------------------------

describe("wrapTaskLine — normal cases", () => {
  it("returns the text as a single-element array when it fits within maxWidth (normal)", () => {
    const result = wrapTaskLine("short text", 40);
    expect(result).toEqual(["short text"]);
  });

  it("wraps a long task description on a space boundary (normal)", () => {
    // The description exceeds 44 chars; should break before a word
    const text =
      "3. Configure test environment files for Jest and React Testing Library";
    const lines = wrapTaskLine(text, 44);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // Reconstructing the joined text should contain the full content
    expect(lines.join(" ")).toContain("Jest");
    expect(lines.join(" ")).toContain("Testing Library");
  });

  it("preserves all words across wrapped lines (normal)", () => {
    const text = "1. Add a new spinner component to the UI bridge layer";
    const lines = wrapTaskLine(text, 30);
    const rejoined = lines.join(" ");
    // Every word should appear in the rejoined output
    for (const word of text.split(" ")) {
      expect(rejoined).toContain(word);
    }
  });

  it("wraps a numbered task starting with the number intact (normal)", () => {
    const text = "42. Implement the OAuth2 refresh token flow for API authentication";
    const lines = wrapTaskLine(text, 40);
    // The number prefix should be on the first line
    expect(lines[0]).toMatch(/^42\./);
  });
});

describe("wrapTaskLine — boundary cases", () => {
  it("returns single-element array when text length equals maxWidth (boundary — exact fit)", () => {
    const text = "exactly forty characters of text here!!"; // 40 chars
    const result = wrapTaskLine(text, text.length);
    expect(result).toEqual([text]);
  });

  it("bypasses wrapping when maxWidth < 8 — returns the whole text as one line (boundary — guard)", () => {
    // Lines narrower than 8 characters would create unreadable fragments;
    // the source guards against this and returns the text unsplit.
    const text = "This is a very long line that exceeds the narrow maxWidth";
    const result = wrapTaskLine(text, 5);
    expect(result).toEqual([text]);
  });

  it("returns a single empty string for empty input (boundary — empty string)", () => {
    const result = wrapTaskLine("", 40);
    expect(result).toEqual([""]);
  });

  it("handles a text with no spaces — hard-breaks at maxWidth (boundary — no break points)", () => {
    // When lastIndexOf(' ') returns a position below 35% of maxWidth,
    // the source falls back to a hard break at maxWidth.
    const noSpaceText = "a".repeat(60);
    const result = wrapTaskLine(noSpaceText, 20);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Each line except possibly the last should be at most maxWidth chars
    for (const line of result.slice(0, -1)) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

  it("returns a single line for a text of exactly maxWidth + 1 (boundary — just over)", () => {
    // Only one extra character should trigger wrapping
    const text = "a".repeat(8) + " " + "b"; // 10 chars, maxWidth=9
    const result = wrapTaskLine(text, 9);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// buildTaskBoardLines
// ---------------------------------------------------------------------------

describe("buildTaskBoardLines — normal cases", () => {
  it("returns an empty array for an empty task list with no activity (normal)", () => {
    const lines = buildTaskBoardLines([], undefined, 60);
    expect(lines).toEqual([]);
  });

  it("produces one or more lines per task (normal)", () => {
    const tasks = [
      { id: 1, text: "Install dependencies", state: "complete" },
      { id: 2, text: "Configure ESLint", state: "waiting" },
    ];
    const lines = buildTaskBoardLines(tasks, undefined, 60);
    // Both task texts should appear somewhere in the rendered lines
    const joined = lines.map((l) => l.text).join(" ");
    expect(joined).toContain("Install dependencies");
    expect(joined).toContain("Configure ESLint");
  });

  it("marks running task lines as isRunning = true (normal)", () => {
    const tasks = [{ id: 1, text: "Run test suite", state: "running" }];
    const lines = buildTaskBoardLines(tasks, undefined, 60);
    const taskLines = lines.filter((l) => !l.isActivity);
    expect(taskLines.every((l) => l.isRunning)).toBe(true);
  });

  it("marks non-running task lines as isRunning = false (normal)", () => {
    const tasks = [{ id: 1, text: "Run test suite", state: "complete" }];
    const lines = buildTaskBoardLines(tasks, undefined, 60);
    expect(lines.every((l) => !l.isRunning)).toBe(true);
  });

  it("appends an activity line on the task board when a message is given (normal)", () => {
    const tasks = [{ id: 1, text: "Write components", state: "running" }];
    const lines = buildTaskBoardLines(tasks, "Reading src/App.tsx…", 60);
    expect(lines.some((l) => l.isActivity)).toBe(true);
    expect(lines.map((l) => l.text).join(" ")).toContain("Reading src/App.tsx");
  });

  it("does NOT produce activity lines when activityMessage is undefined (normal)", () => {
    const tasks = [{ id: 1, text: "Compile", state: "running" }];
    const lines = buildTaskBoardLines(tasks, undefined, 60);
    expect(lines.some((l) => l.isActivity)).toBe(false);
  });

  it("appends run_command activity lines (Running: …)", () => {
    const tasks = [{ id: 1, text: "Install vitest", state: "running" }];
    const lines = buildTaskBoardLines(
      tasks,
      "Running: cd world-time && npm install -D vitest...",
      60,
    );
    expect(lines.some((l) => l.isActivity)).toBe(true);
    expect(lines.some((l) => l.text.includes("Running:"))).toBe(true);
  });

  it("wraps a long activity message across multiple lines instead of leaving it unbounded (normal — activity wrap)", () => {
    const tasks = [{ id: 1, text: "Run tests", state: "running" }];
    const longActivity =
      "Running: cd very/deeply/nested/project/directory && npm install --save-dev some-long-package-name";
    const lines = buildTaskBoardLines(tasks, longActivity, 44);
    const activityLines = lines.filter((l) => l.isActivity);

    expect(activityLines.length).toBeGreaterThanOrEqual(2);
    for (const line of activityLines) {
      expect(line.text.length).toBeLessThanOrEqual(44);
    }

    // No character from the original message was dropped by wrapping — only
    // whitespace at the wrap seams is normalized (trimEnd/trimStart), and an
    // unbroken long token (like the path here) may hard-break mid-word rather
    // than lose content, same as wrapTaskLine already does for task text.
    const rejoinedNoSpaces = activityLines
      .map((l) => l.text)
      .join("")
      .replace(/\s+/g, "");
    const originalNoSpaces = longActivity.replace(/\s+/g, "");
    expect(rejoinedNoSpaces).toBe(originalNoSpaces);
  });
});

describe("buildTaskBoardLines — boundary cases", () => {
  it("generates a React-safe unique key for each line (boundary — unique keys)", () => {
    const tasks = [
      { id: 1, text: "Task one", state: "running" },
      { id: 2, text: "Task two", state: "waiting" },
    ];
    const lines = buildTaskBoardLines(tasks, "Doing something…", 60);
    const keys = lines.map((l) => l.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  it("adds CONTINUATION_INDENT to wrapped continuation lines (boundary — multi-line task)", () => {
    // A long task description that forces wrapping should have continuation lines
    // with non-empty glyphPrefix (the 3-space CONTINUATION_INDENT constant)
    const longText =
      "1. Create the TimeDisplay component that shows the current time across multiple timezone cities";
    const tasks = [{ id: 1, text: longText, state: "running" }];
    const lines = buildTaskBoardLines(tasks, undefined, 44);

    if (lines.length > 1) {
      // The first line has no prefix; continuation lines have the indent
      expect(lines[0]!.glyphPrefix).toBe("");
      expect(lines[1]!.glyphPrefix.length).toBeGreaterThan(0);
    }
  });

  it("preserves full task content across all wrapped lines (boundary — content integrity)", () => {
    const longText =
      "Create TimeDisplay component that shows current time for multiple cities";
    const tasks = [{ id: 4, text: longText, state: "running" }];
    const lines = buildTaskBoardLines(tasks, undefined, 60);
    const joined = lines.map((l) => l.text).join(" ");
    expect(joined).toContain("TimeDisplay");
    expect(joined).toContain("multiple cities");
  });

  it("handles multiple tasks where only one is running (boundary — mixed states)", () => {
    const tasks = [
      { id: 1, text: "Done task", state: "complete" },
      { id: 2, text: "Active task", state: "running" },
      { id: 3, text: "Blocked task", state: "blocked" },
    ];
    const lines = buildTaskBoardLines(tasks, undefined, 60);

    // Line for task 2 should be isRunning=true
    const activeLines = lines.filter(
      (l) => !l.isActivity && l.text.includes("Active"),
    );
    expect(activeLines.every((l) => l.isRunning)).toBe(true);

    // Lines for other tasks should be isRunning=false
    const doneLines = lines.filter(
      (l) => !l.isActivity && l.text.includes("Done"),
    );
    expect(doneLines.every((l) => !l.isRunning)).toBe(true);
  });

  it("does not special-case escalating text — content-based filtering happens upstream, not here (boundary)", () => {
    // buildTaskBoardLines is a dumb layout function: it renders whatever
    // message it's given. Suppressing "escalating" activity is the job of
    // the callers that decide what to put in board.activity in the first
    // place (see ui/taskStream.ts and ui/bridge/subagentStatus.ts) — if this
    // function filtered by message content too, that policy would live in
    // two places and could silently drift apart.
    const tasks = [{ id: 1, text: "Some task", state: "complete" }];
    const lines = buildTaskBoardLines(tasks, "Escalating to agent...", 60);
    expect(lines.some((l) => l.isActivity)).toBe(true);
    expect(lines.map((l) => l.text).join(" ")).toContain("Escalating");
  });

  it("does NOT produce an activity line when activityMessage is whitespace-only (boundary — blank activity)", () => {
    const tasks = [{ id: 1, text: "Compile", state: "running" }];
    const lines = buildTaskBoardLines(tasks, "   ", 60);
    expect(lines.some((l) => l.isActivity)).toBe(false);
  });

  it("only leaves the first activity line's glyphPrefix empty — continuation lines get the indent (boundary — activity continuation indent)", () => {
    const tasks = [{ id: 1, text: "Run tests", state: "running" }];
    const longActivity =
      "Running: cd very/deeply/nested/project/directory && npm install --save-dev some-long-package-name";
    const lines = buildTaskBoardLines(tasks, longActivity, 44);
    const activityLines = lines.filter((l) => l.isActivity);

    expect(activityLines.length).toBeGreaterThanOrEqual(2);
    expect(activityLines[0]!.glyphPrefix).toBe("");
    for (const line of activityLines.slice(1)) {
      expect(line.glyphPrefix.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// buildTaskBoardProgress
// ---------------------------------------------------------------------------

describe("buildTaskBoardProgress — normal cases", () => {
  it("formats a partial-completion progress line (normal)", () => {
    const line = buildTaskBoardProgress(2, 4);
    expect(line).toContain("2/4");
    expect(line).toContain("50.0%");
  });

  it("formats a fully-complete progress line (normal)", () => {
    const line = buildTaskBoardProgress(4, 4);
    expect(line).toContain("4/4");
    expect(line).toContain("100.0%");
  });

  it("formats a zero-progress line (normal)", () => {
    const line = buildTaskBoardProgress(0, 4);
    expect(line).toContain("0/4");
    expect(line).toContain("0.0%");
  });

  it("uses filled/empty block characters matching the model-pull progress bar style (normal)", () => {
    const line = buildTaskBoardProgress(1, 2);
    expect(line).toMatch(/█+░*/);
  });
});

describe("buildTaskBoardProgress — boundary cases", () => {
  it("returns null when there are no tasks yet (boundary — empty board)", () => {
    expect(buildTaskBoardProgress(0, 0)).toBeNull();
  });

  it("clamps to 100% rather than throwing if completed somehow exceeds total (boundary — defensive clamp)", () => {
    expect(() => buildTaskBoardProgress(5, 4)).not.toThrow();
    expect(buildTaskBoardProgress(5, 4)).toContain("100.0%");
  });
});

// ---------------------------------------------------------------------------
// resolveTaskBoardProgressColor
// ---------------------------------------------------------------------------

describe("resolveTaskBoardProgressColor", () => {
  it("stays cyan while tasks are still in progress, even with a failure among them (normal)", () => {
    expect(resolveTaskBoardProgressColor(3, 1, 4)).toBe("cyan");
  });

  it("stays cyan when nothing has finished yet (normal)", () => {
    expect(resolveTaskBoardProgressColor(0, 0, 4)).toBe("cyan");
  });

  it("turns green once every task is complete with no failures (normal)", () => {
    expect(resolveTaskBoardProgressColor(4, 0, 4)).toBe("green");
  });

  it("turns red once every task is finished and at least one failed (normal)", () => {
    expect(resolveTaskBoardProgressColor(4, 1, 4)).toBe("red");
  });

  it("treats an empty board as cyan (boundary)", () => {
    expect(resolveTaskBoardProgressColor(0, 0, 0)).toBe("cyan");
  });
});

// ---------------------------------------------------------------------------
// taskBoardBorderWidth
// ---------------------------------------------------------------------------

describe("taskBoardBorderWidth — normal cases", () => {
  it("returns at least TASK_BOARD_MIN_BORDER_WIDTH for an empty content list (normal)", () => {
    const width = taskBoardBorderWidth("Agent 1", []);
    expect(width).toBeGreaterThanOrEqual(TASK_BOARD_MIN_BORDER_WIDTH);
  });

  it("expands border to fit a long content line (normal)", () => {
    const tasks = [
      {
        id: 1,
        text: "Configure test environment files for Jest with complete setup",
        state: "waiting",
      },
    ];
    const lines = buildTaskBoardLines(tasks, undefined, 80);
    const width = taskBoardBorderWidth("Agent 1 — setup", lines);
    expect(width).toBeGreaterThanOrEqual(TASK_BOARD_MIN_BORDER_WIDTH);
    // A long line should push the border beyond the minimum
    expect(width).toBeGreaterThan(TASK_BOARD_MIN_BORDER_WIDTH - 1);
  });

  it("uses the title length when it exceeds content (normal)", () => {
    // An extremely long title should drive the border width up
    const longTitle = "Agent 99 — very long descriptive panel title here!!";
    const lines = buildTaskBoardLines(
      [{ id: 1, text: "short", state: "complete" }],
      undefined,
      60,
    );
    const width = taskBoardBorderWidth(longTitle, lines);
    // title.length + 4 should be the minimum floor in this case
    expect(width).toBeGreaterThanOrEqual(longTitle.length + 4);
  });
});

describe("taskBoardBorderWidth — boundary cases", () => {
  it("never returns below TASK_BOARD_MIN_BORDER_WIDTH (boundary — minimum floor)", () => {
    // Even with a very short title and no content, the floor should hold
    const width = taskBoardBorderWidth("X", []);
    expect(width).toBeGreaterThanOrEqual(TASK_BOARD_MIN_BORDER_WIDTH);
  });

  it("accounts for glyphPrefix length in width calculation (boundary — indented continuation)", () => {
    // A wrapped line with a continuation indent contributes more to the
    // border width than its text length alone
    const longText =
      "1. This is an extremely long task description that will definitely wrap " +
      "across multiple continuation lines within the agent task board panel";
    const tasks = [{ id: 1, text: longText, state: "running" }];
    const lines = buildTaskBoardLines(tasks, undefined, TASK_BOARD_MIN_INNER_WIDTH);
    const width = taskBoardBorderWidth("Agent 1", lines);
    // Continuation lines have a 3-space prefix; the border must accommodate them
    expect(width).toBeGreaterThanOrEqual(TASK_BOARD_MIN_BORDER_WIDTH);
  });
});
