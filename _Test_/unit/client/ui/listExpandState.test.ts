/**
 * Unit tests — listExpandState.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  clearExpandState,
  isExpanded,
  markExpanded,
  peekUnexpanded,
  pushListDir,
} from "../../../../packages/client/src/state/listExpandState.js";

describe("listExpandState", () => {
  afterEach(() => {
    clearExpandState();
  });

  it("pushListDir + peekUnexpanded returns the newest unexpanded entry", () => {
    pushListDir("/a", 0);
    pushListDir("/b", 4);
    const next = peekUnexpanded();
    expect(next.found).toBe(true);
    expect(next.entry?.absolutePath).toBe("/b");
  });

  it("markExpanded / isExpanded track expansion", () => {
    pushListDir("/a", 0);
    expect(isExpanded("/a")).toBe(false);
    markExpanded("/a");
    expect(isExpanded("/a")).toBe(true);
    expect(peekUnexpanded().found).toBe(false);
  });

  it("clearExpandState empties the stack", () => {
    pushListDir("/a", 0);
    clearExpandState();
    expect(peekUnexpanded().found).toBe(false);
  });
});
