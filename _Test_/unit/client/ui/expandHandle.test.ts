/**
 * Unit tests — client ui/multiline/expandHandle.ts
 *
 * The input component registers a function that expands paste placeholders
 * back to their full text, while the global keyboard handler requests it
 * before queueing a message typed while busy. The module-level slot must be
 * safe when no prompt is mounted and resistant to stale component cleanups.
 * Mirrors `newlineHandle.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerExpandHandle,
  requestExpand,
} from "../../../../packages/client/src/ui/multiline/expandHandle.js";

afterEach(() => {
  // Reset the module-level handle so tests cannot influence one another.
  registerExpandHandle(null);
});

describe("requestExpand", () => {
  it("returns the input unchanged when no multiline input is registered (boundary)", () => {
    expect(requestExpand("[Pasted text #1: 4 lines]")).toBe(
      "[Pasted text #1: 4 lines]",
    );
  });

  it("calls the currently registered expander and returns its result (normal)", () => {
    const handle = vi.fn((text: string) => text.toUpperCase());
    registerExpandHandle(handle);

    const result = requestExpand("abc");

    expect(handle).toHaveBeenCalledWith("abc");
    expect(result).toBe("ABC");
  });
});

describe("registerExpandHandle", () => {
  it("unregisters the current handler when its disposer runs (normal)", () => {
    const handle = vi.fn((text: string) => `${text}!`);
    const dispose = registerExpandHandle(handle);

    dispose();

    expect(requestExpand("abc")).toBe("abc");
    expect(handle).not.toHaveBeenCalled();
  });

  it("does not let a stale disposer unregister a newer input handler (boundary)", () => {
    const first = vi.fn((text: string) => `first:${text}`);
    const second = vi.fn((text: string) => `second:${text}`);
    const disposeFirst = registerExpandHandle(first);
    const disposeSecond = registerExpandHandle(second);

    disposeFirst();

    expect(requestExpand("abc")).toBe("second:abc");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    disposeSecond();
    expect(requestExpand("abc")).toBe("abc");
    expect(second).toHaveBeenCalledOnce();
  });

  it("accepts null as an explicit unregister operation (boundary)", () => {
    const handle = vi.fn((text: string) => `${text}!`);
    registerExpandHandle(handle);
    registerExpandHandle(null);

    expect(requestExpand("abc")).toBe("abc");
    expect(handle).not.toHaveBeenCalled();
  });
});
