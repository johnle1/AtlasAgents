/**
 * Unit tests — client ui/multiline/newlineHandle.ts
 *
 * The input component registers the active newline callback, while the global
 * keyboard handler requests it. The module-level slot must be safe when no
 * prompt is mounted and resistant to stale component cleanups.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerNewlineHandle,
  requestNewline,
} from "../../../../packages/client/src/ui/multiline/newlineHandle.js";

afterEach(() => {
  // Reset the module-level handle so tests cannot influence one another.
  registerNewlineHandle(null);
});

describe("requestNewline", () => {
  it("is a no-op when no multiline input is registered (boundary)", () => {
    expect(() => requestNewline()).not.toThrow();
  });

  it("calls the currently registered input handler (normal)", () => {
    const handle = vi.fn();
    registerNewlineHandle(handle);

    requestNewline();

    expect(handle).toHaveBeenCalledOnce();
  });
});

describe("registerNewlineHandle", () => {
  it("unregisters the current handler when its disposer runs (normal)", () => {
    const handle = vi.fn();
    const dispose = registerNewlineHandle(handle);

    requestNewline();
    dispose();
    requestNewline();

    expect(handle).toHaveBeenCalledOnce();
  });

  it("does not let a stale disposer unregister a newer input handler (boundary)", () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = registerNewlineHandle(first);
    const disposeSecond = registerNewlineHandle(second);

    disposeFirst();
    requestNewline();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    disposeSecond();
    requestNewline();
    expect(second).toHaveBeenCalledOnce();
  });

  it("accepts null as an explicit unregister operation (boundary)", () => {
    const handle = vi.fn();
    registerNewlineHandle(handle);
    registerNewlineHandle(null);

    requestNewline();

    expect(handle).not.toHaveBeenCalled();
  });
});
