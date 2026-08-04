/**
 * Unit tests — connection/lifecycle.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionLifecycle } from "../../../../packages/client/src/connection/lifecycle.js";

describe("ConnectionLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies listeners immediately and on status change", () => {
    const seen: string[] = [];
    const statusListenerCallback = vi.fn((s: string) => seen.push(s));
    const connect = vi.fn();
    const clearSocket = vi.fn();
    const lifecycle = new ConnectionLifecycle({ connect, clearSocket });
    const off = lifecycle.onConnectionStatus(statusListenerCallback);
    expect(seen).toEqual(["Disconnected"]);

    lifecycle.emitStatus("Connecting");
    lifecycle.emitStatus("Connecting");
    lifecycle.emitStatus("Connected");
    expect(seen).toEqual(["Disconnected", "Connecting", "Connected"]);
    off();
    lifecycle.emitStatus("Disconnected");
    expect(seen).toEqual(["Disconnected", "Connecting", "Connected"]);
  });

  it("handleSocketClosed clears socket and schedules reconnect", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const clearSocket = vi.fn();
    const lifecycle = new ConnectionLifecycle({ connect, clearSocket });

    lifecycle.handleSocketClosed();
    expect(clearSocket).toHaveBeenCalled();
    expect(lifecycle.getStatus()).toBe("Reconnecting");

    await vi.runAllTimersAsync();
    expect(connect).toHaveBeenCalled();
  });

  it("suppresses reconnect when flag is set", () => {
    const connect = vi.fn();
    const lifecycle = new ConnectionLifecycle({
      connect,
      clearSocket: vi.fn(),
    });
    lifecycle.setSuppressReconnect(true);
    lifecycle.handleSocketClosed();
    expect(lifecycle.getStatus()).toBe("Disconnected");
    vi.runAllTimers();
    expect(connect).not.toHaveBeenCalled();
  });

  it("cancelReconnect clears pending timer", () => {
    const lifecycle = new ConnectionLifecycle({
      connect: vi.fn(),
      clearSocket: vi.fn(),
    });
    lifecycle.scheduleReconnect();
    lifecycle.cancelReconnect(); // uses clearTimeout internally
    vi.runAllTimers();
    expect(lifecycle.getStatus()).toBe("Reconnecting");
  });

  it("emitStatus iterates statusListener callbacks", () => {
    const lifecycle = new ConnectionLifecycle({
      connect: vi.fn(),
      clearSocket: vi.fn(),
    });
    const statusListener = vi.fn();
    lifecycle.onConnectionStatus(statusListener);
    statusListener.mockClear();
    lifecycle.emitStatus("Connecting");
    expect(statusListener).toHaveBeenCalledWith("Connecting");
  });

  it("resetReconnectAttempt resets backoff counter after success path", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const lifecycle = new ConnectionLifecycle({
      connect,
      clearSocket: vi.fn(),
    });
    lifecycle.scheduleReconnect();
    await vi.runAllTimersAsync();
    expect(connect).toHaveBeenCalledTimes(1);
    lifecycle.resetReconnectAttempt();
    lifecycle.scheduleReconnect();
    await vi.runAllTimersAsync();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
