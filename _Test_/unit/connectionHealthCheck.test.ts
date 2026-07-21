/**
 * Unit tests — client connection/connection.ts health check timer cleanup
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../packages/client/src/config.js";
import { HEALTH_CHECK_TIMEOUT_MS } from "../../packages/client/src/connection/constants.js";

const { mockSendCommand } = vi.hoisted(() => ({
  mockSendCommand: vi.fn(),
}));

vi.mock("../../packages/client/src/connection/commands.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../packages/client/src/connection/commands.js")
    >();
  return { ...actual, sendCommand: mockSendCommand };
});

import { Connection } from "../../packages/client/src/connection/connection.js";

type MockRSocket = { close: ReturnType<typeof vi.fn> };

/** Bypass private `rsocket` — intersection with Connection reduces to `never`. */
const setRsocket = (connection: Connection, rsocket: MockRSocket | null): void => {
  (connection as unknown as { rsocket: MockRSocket | null }).rsocket = rsocket;
};

const getRsocket = (connection: Connection): MockRSocket | null =>
  (connection as unknown as { rsocket: MockRSocket | null }).rsocket;

const emitLifecycleStatus = (connection: Connection, status: string): void => {
  (
    connection as unknown as { lifecycle: { emitStatus: (s: string) => void } }
  ).lifecycle.emitStatus(status);
};

const minimalConfig = {
  server: "localhost",
  port: 7000,
  password: "",
  subagentModel: "agent",
  subagentModel: "agent",
  agentTemp: 0,
  agentTemp: 0.4,
  retries: 3,
  timeout: 5000,
  workspace: "",
  ui: { theme: "default" },
} as Config;

const makeConnected = (): Connection => {
  const connection = new Connection(minimalConfig);
  emitLifecycleStatus(connection, "Connected");
  return connection;
};

beforeEach(() => {
  vi.useFakeTimers();
  mockSendCommand.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Connection.healthCheckRunner", () => {
  it("clears timeout and does not close socket on success", async () => {
    const connection = makeConnected();
    const close = vi.fn();
    setRsocket(connection, { close });
    mockSendCommand.mockResolvedValue({ ok: true });

    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    await connection.healthCheckRunner();

    expect(mockSendCommand).toHaveBeenCalledWith(
      getRsocket(connection),
      "session.exists",
      {},
      expect.any(Buffer),
    );
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("clears timeout and closes socket on command error", async () => {
    const connection = makeConnected();
    const close = vi.fn();
    setRsocket(connection, { close });
    mockSendCommand.mockRejectedValue(new Error("network"));

    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    await connection.healthCheckRunner();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("clears timeout and closes socket when health check times out", async () => {
    const connection = makeConnected();
    const close = vi.fn();
    setRsocket(connection, { close });
    mockSendCommand.mockImplementation(() => new Promise(() => {}));

    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    const run = connection.healthCheckRunner();
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS);
    await run;

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns early when not connected", async () => {
    const connection = new Connection(minimalConfig);
    setRsocket(connection, { close: vi.fn() });
    await connection.healthCheckRunner();
    expect(mockSendCommand).not.toHaveBeenCalled();
  });

  it("does not close swapped socket after success", async () => {
    const connection = makeConnected();
    const oldSocket = { close: vi.fn() };
    const newSocket = { close: vi.fn() };
    setRsocket(connection, oldSocket);
    mockSendCommand.mockImplementation(async () => {
      setRsocket(connection, newSocket);
    });

    await connection.healthCheckRunner();
    expect(oldSocket.close).not.toHaveBeenCalled();
    expect(newSocket.close).not.toHaveBeenCalled();
  });

  it("does not close swapped socket after error", async () => {
    const connection = makeConnected();
    const oldSocket = { close: vi.fn() };
    const newSocket = { close: vi.fn() };
    setRsocket(connection, oldSocket);
    mockSendCommand.mockImplementation(async () => {
      setRsocket(connection, newSocket);
      throw new Error("fail");
    });

    await connection.healthCheckRunner();
    expect(oldSocket.close).not.toHaveBeenCalled();
    expect(newSocket.close).not.toHaveBeenCalled();
  });
});
