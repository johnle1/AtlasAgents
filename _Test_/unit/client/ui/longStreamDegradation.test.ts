/**
 * Terminal UI Degradation & Performance Tests
 *
 * Tests the terminal formatting and layout engines under heavy load:
 * - Very long streamed outputs (10K+ characters)
 * - Large number of subtasks and tool-call turns in a single session
 * - Extreme terminal column widths (narrow vs ultra-wide)
 */

import { describe, expect, it } from "vitest";
import {
  wrapTaskLine,
  buildTaskBoardLines,
  taskBoardInnerWidth,
  taskBoardBorderWidth,
  TASK_BOARD_BORDER_RESERVED_COLUMNS,
} from "../../../../packages/client/src/ui/taskBoardLayout.js";

describe("Long Stream & High Load Terminal Degradation", () => {
  it("wraps a 50,000 character continuous stream without stack overflow or performance hitch", () => {
    // Generate a long streamed payload with mixed spaces and long identifiers
    const words = ["function", "asyncHandler()", "implements", "IOllamaClient", "with", "extremely_long_identifier_name_without_spaces_1234567890"];
    let longPayload = "";
    for (let i = 0; i < 2000; i++) {
      longPayload += words[i % words.length] + " ";
    }

    const start = performance.now();
    const wrapped = wrapTaskLine(longPayload, 80);
    const duration = performance.now() - start;

    expect(wrapped.length).toBeGreaterThan(100);
    expect(duration).toBeLessThan(200); // Should format in < 200ms
    wrapped.forEach((line) => {
      // Each line should not exceed maxWidth (unless an unbroken token exceeds maxWidth)
      if (!line.includes("extremely_long_identifier_name_without_spaces_1234567890")) {
        expect(line.length).toBeLessThanOrEqual(80);
      }
    });
  });

  it("builds task board lines for 100+ concurrent/sequential subagent tasks cleanly", () => {
    const tasks: Array<{ id: number; text: string; state: string }> = [];
    for (let i = 0; i < 100; i++) {
      tasks.push({
        id: i + 1,
        text: `Subagent worker #${i} executing complex tool orchestration step with long description`,
        state: i % 4 === 0 ? "running" : i % 4 === 1 ? "completed" : i % 4 === 2 ? "pending" : "failed",
      });
    }

    const lines = buildTaskBoardLines(tasks, "Active: verifying results...", 80);
    expect(lines.length).toBeGreaterThan(100);
    // Every line produced should have valid keys and fields
    lines.forEach((line) => {
      expect(typeof line.key).toBe("string");
      expect(typeof line.text).toBe("string");
      expect(typeof line.isRunning).toBe("boolean");
    });
  });

  it("handles boundary terminal column widths without generating negative or zero widths", () => {
    const innerWidth = taskBoardInnerWidth(TASK_BOARD_BORDER_RESERVED_COLUMNS);
    expect(innerWidth).toBeGreaterThan(0);

    const dummyLines = buildTaskBoardLines(
      [{ id: 1, text: "Sample task", state: "running" }],
      undefined,
      innerWidth,
    );
    const borderWidth = taskBoardBorderWidth("Agent Plan", dummyLines);
    expect(borderWidth).toBeGreaterThanOrEqual(48); // Clamped to TASK_BOARD_MIN_BORDER_WIDTH

    // Text wrapping at minimum width
    const wrappedNarrow = wrapTaskLine("Testing very narrow terminal width behavior", 8);
    expect(wrappedNarrow.length).toBeGreaterThan(0);
  });
});
