/**
 * Unit tests — client ui/bootstrap/wireSessionAbortSignal.ts
 */

import { describe, expect, it, vi } from "vitest";
import { wireSessionAbortSignal } from "../../../packages/client/src/ui/bootstrap/wireSessionAbortSignal.js";
import type { Connection } from "../../../packages/client/src/connection/index.js";
import type { LocalFileProxy } from "../../../packages/client/src/localFileProxy.js";

describe("wireSessionAbortSignal", () => {
  it("registers getter that returns connection session abort signal", () => {
    const signal = new AbortController().signal;
    const getSessionAbortSignal = vi.fn(() => signal);
    const setSessionAbortSignal = vi.fn();

    const connection = { getSessionAbortSignal } as unknown as Connection;
    const fileProxy = { setSessionAbortSignal } as unknown as LocalFileProxy;

    wireSessionAbortSignal(connection, fileProxy);

    expect(setSessionAbortSignal).toHaveBeenCalledOnce();
    const getter = setSessionAbortSignal.mock.calls[0]?.[0] as () => AbortSignal;
    expect(getter()).toBe(signal);
    expect(getSessionAbortSignal).toHaveBeenCalled();
  });
});
