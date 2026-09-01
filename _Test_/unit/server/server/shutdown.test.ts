/**
 * Unit tests — server/shutdown.ts
 *
 * @remarks
 * Regression guard for the "PID survives Ctrl+C" bug: the server used to
 * register a `SIGINT` listener (in `ollama/lifecycle.ts`) that killed the
 * Ollama child and returned without ever calling `process.exit`, which
 * disabled Node's default terminate-on-SIGINT and left the process running
 * forever behind the still-open TLS listener. These tests assert the fixed
 * shutdown sequence's ordering and its behavior when a step is slow or
 * absent, using fully injected dependencies (no real signals, sockets, or
 * `process.exit`) — see `shutdown.ts`'s module remarks for why this logic
 * lives in its own file rather than `server/index.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  disposeConnection,
  performShutdown,
  SHUTDOWN_WATCHDOG_MS,
} from "../../../../packages/server/src/server/shutdown.js";
import type { AppContainer } from "../../../../packages/server/src/container/index.js";

const makePerConnection = () => ({
  planBroker: { dispose: vi.fn() },
  workspace: { dispose: vi.fn() },
  terminal: { dispose: vi.fn() },
});

const makeApp = (
  connections: Record<string, ReturnType<typeof makePerConnection>> = {},
): AppContainer =>
  ({
    brokerByRequester: new Map(Object.entries(connections)),
    modelPlacementReporter: { forgetScope: vi.fn() },
  }) as unknown as AppContainer;

describe("disposeConnection", () => {
  it("disposes planBroker, workspace, and terminal, then removes the entry and forgets the placement scope (normal)", () => {
    const conn = makePerConnection();
    const app = makeApp({ req_1: conn });

    disposeConnection(app, "req_1");

    expect(conn.planBroker.dispose).toHaveBeenCalledTimes(1);
    expect(conn.workspace.dispose).toHaveBeenCalledTimes(1);
    expect(conn.terminal.dispose).toHaveBeenCalledTimes(1);
    expect(app.brokerByRequester.has("req_1")).toBe(false);
    expect(app.modelPlacementReporter.forgetScope).toHaveBeenCalledWith("req_1");
  });

  it("still forgets the placement scope for a requesterId with no live connection (boundary)", () => {
    const app = makeApp();
    disposeConnection(app, "never-connected");
    expect(app.modelPlacementReporter.forgetScope).toHaveBeenCalledWith(
      "never-connected",
    );
  });
});

describe("performShutdown", () => {
  it("aborts in-flight work, stops accepting connections, disposes every survivor, stops a self-started Ollama, then exits 0 — in that order (normal)", () => {
    const calls: string[] = [];
    const conn = makePerConnection();
    const app = makeApp({ req_1: conn });
    const server = {
      abortAll: vi.fn(() => calls.push("abortAll")),
      stop: vi.fn(() => calls.push("stop")),
    };
    const ollamaLifecycle = {
      startedByServer: true,
      stop: vi.fn(() => calls.push("ollamaStop")),
    };
    const exit = vi.fn((code: number) => calls.push(`exit(${code})`));

    performShutdown(app, server, ollamaLifecycle, exit);

    // Order matters: abort before close (see shutdown.ts's module remarks —
    // server.stop() alone does not drop already-open sockets), disposal of
    // survivors before Ollama teardown, exit last.
    expect(calls).toEqual(["abortAll", "stop", "ollamaStop", "exit(0)"]);
    expect(conn.planBroker.dispose).toHaveBeenCalledTimes(1);
    expect(app.brokerByRequester.size).toBe(0);
  });

  it("does not stop Ollama when this process didn't start it (normal — startedByServer: false)", () => {
    const app = makeApp();
    const server = { abortAll: vi.fn(), stop: vi.fn() };
    const ollamaLifecycle = { startedByServer: false, stop: vi.fn() };
    const exit = vi.fn();

    performShutdown(app, server, ollamaLifecycle, exit);

    expect(ollamaLifecycle.stop).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("disposes every survivor, not just one, when multiple connections are still live (boundary)", () => {
    const connA = makePerConnection();
    const connB = makePerConnection();
    const app = makeApp({ req_a: connA, req_b: connB });
    const server = { abortAll: vi.fn(), stop: vi.fn() };
    const ollamaLifecycle = { startedByServer: false, stop: vi.fn() };

    performShutdown(app, server, ollamaLifecycle, vi.fn());

    expect(connA.workspace.dispose).toHaveBeenCalledTimes(1);
    expect(connB.workspace.dispose).toHaveBeenCalledTimes(1);
    expect(app.brokerByRequester.size).toBe(0);
  });

  it("the watchdog fires exit(1) on its own timer if a step throws before teardown reaches exit(0) (error — the watchdog is independent of the synchronous body)", () => {
    vi.useFakeTimers();
    try {
      const app = makeApp();
      const exit = vi.fn();
      // A step that throws instead of completing — teardown never reaches
      // its own `exit(0)` call. The watchdog was armed before this ran, so
      // it fires independently once its timer elapses, regardless of why
      // the synchronous body never got to the end.
      const server = {
        abortAll: vi.fn(),
        stop: vi.fn(() => {
          throw new Error("simulated failure: never returns cleanly");
        }),
      };
      const ollamaLifecycle = { startedByServer: false, stop: vi.fn() };

      expect(() => performShutdown(app, server, ollamaLifecycle, exit)).toThrow();
      expect(exit).not.toHaveBeenCalled();

      vi.advanceTimersByTime(SHUTDOWN_WATCHDOG_MS);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the watchdog on a clean exit — the timer never fires afterward (regression guard)", () => {
    vi.useFakeTimers();
    try {
      const app = makeApp();
      const exit = vi.fn();
      const server = { abortAll: vi.fn(), stop: vi.fn() };
      const ollamaLifecycle = { startedByServer: false, stop: vi.fn() };

      performShutdown(app, server, ollamaLifecycle, exit);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);

      vi.advanceTimersByTime(SHUTDOWN_WATCHDOG_MS);
      // Still just the one clean exit(0) — the watchdog was cleared, so it
      // never adds a stray exit(1) after teardown already finished.
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
