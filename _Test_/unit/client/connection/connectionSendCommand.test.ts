/**
 * Unit tests — Connection.sendCommand and health monitor clearInterval.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../../../packages/client/src/config/index.js";
import { Connection } from "../../../../packages/client/src/connection/connection.js";
import {
  CONNECT_RETRY_INTERVAL_MS,
  HEALTH_CHECK_INTERVAL_MS,
} from "../../../../packages/client/src/connection/constants.js";

const { mockSendCommand } = vi.hoisted(() => ({
  mockSendCommand: vi.fn(),
}));

vi.mock("../../../../packages/client/src/connection/commands.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../packages/client/src/connection/commands.js")
    >();
  return { ...actual, sendCommand: mockSendCommand };
});

const minimalConfig = {
  server: "localhost",
  port: 7000,
  password: "secret",
  subagentModel: "agent",
  subsubagentModel: "agent",
  subagentCap: 3,
  agentProvider: "ollama",
  subagentProvider: "ollama",
  agentTemp: 0,
  subagentTemp: 0.4,
  retries: 3,
  timeout: 5000,
  workspace: "",
  ui: { theme: "default" },
} as Config;

const setRsocket = (connection: Connection, rsocket: { close: ReturnType<typeof vi.fn> } | null): void => {
  (connection as unknown as { rsocket: typeof rsocket }).rsocket = rsocket;
};

const emitConnected = (connection: Connection): void => {
  (
    connection as unknown as { lifecycle: { emitStatus: (s: string) => void } }
  ).lifecycle.emitStatus("Connected");
};

const startHealthMonitor = (connection: Connection): void => {
  (
    connection as unknown as { startHealthMonitor: () => void }
  ).startHealthMonitor();
};

const stopHealthMonitor = (connection: Connection): void => {
  (
    connection as unknown as { stopHealthMonitor: () => void }
  ).stopHealthMonitor();
};

describe("Connection.sendCommand", () => {
  beforeEach(() => {
    mockSendCommand.mockReset();
    mockSendCommand.mockResolvedValue({ ok: true });
  });

  it("delegates to sendCommandFn with auth metadata", async () => {
    const connection = new Connection(minimalConfig);
    emitConnected(connection);
    setRsocket(connection, { close: vi.fn() });
    mockSendCommand.mockResolvedValueOnce({ message: "cleared" });

    const result = await connection.sendCommand<{ message: string }>(
      "session.clear",
      {},
    );

    expect(result).toEqual({ message: "cleared" });
    expect(mockSendCommand).toHaveBeenCalledWith(
      expect.anything(),
      "session.clear",
      {},
      expect.any(Buffer),
    );
    const meta = JSON.parse(
      mockSendCommand.mock.calls[0]![3].toString("utf8"),
    );
    expect(meta.password).toBe("secret");
  });
});

describe("Connection health monitor timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clearInterval runs when stopHealthMonitor is called", () => {
    const connection = new Connection(minimalConfig);
    emitConnected(connection);
    setRsocket(connection, { close: vi.fn() });

    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    startHealthMonitor(connection);
    stopHealthMonitor(connection);

    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("setInterval arms periodic health checks", async () => {
    const connection = new Connection(minimalConfig);
    emitConnected(connection);
    setRsocket(connection, { close: vi.fn() });
    mockSendCommand.mockResolvedValue({ ok: true });

    startHealthMonitor(connection);
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    expect(mockSendCommand).toHaveBeenCalledWith(
      expect.anything(),
      "session.exists",
      {},
      expect.any(Buffer),
    );
    stopHealthMonitor(connection);
  });

  it("waitUntilConnected retries with setTimeout between connect attempts", async () => {
    const connection = new Connection(minimalConfig);
    let connectAttempts = 0;
    // connect is an instance-level arrow-function property, not a prototype
    // method, so it can be overridden directly on this instance.
    (connection as unknown as { connect: () => Promise<void> }).connect =
      async () => {
        connectAttempts += 1;
        if (connectAttempts < 3) {
          throw new Error("connection refused");
        }
        setRsocket(connection, { close: vi.fn() });
      };

    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const waitPromise = (
      connection as unknown as { waitUntilConnected: () => Promise<void> }
    ).waitUntilConnected();

    // Each failed attempt schedules a CONNECT_RETRY_INTERVAL_MS setTimeout
    // before retrying; advance past two of them so the fake connect() can
    // fail twice and then succeed on its third call.
    await vi.advanceTimersByTimeAsync(CONNECT_RETRY_INTERVAL_MS * 2);
    await waitPromise;

    expect(connectAttempts).toBe(3);
    expect(setTimeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      CONNECT_RETRY_INTERVAL_MS,
    );
  });
});
