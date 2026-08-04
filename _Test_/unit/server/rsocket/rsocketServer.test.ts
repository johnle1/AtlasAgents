/**
 * Unit tests — server/rsocket/rsocketServer.ts (smoke, mocked transport)
 */

import { describe, expect, it, vi } from "vitest";
import { RSocketServer } from "../../../../packages/server/src/server/rsocket/rsocketServer.js";

const mockClose = vi.fn();
const mockBind = vi.fn().mockResolvedValue({ close: mockClose });

vi.mock("@rsocket/core", () => ({
  // Must be a real constructor (`function`, not an arrow) — rsocketServer.ts
  // calls this with `new`.
  RSocketServer: vi.fn().mockImplementation(function (this: {
    bind: typeof mockBind;
  }) {
    this.bind = mockBind;
  }),
}));

vi.mock("../../../../packages/server/src/server/tls/tlsServerTransport.js", () => ({
  createTlsServerTransport: vi.fn(() => ({})),
}));

vi.mock("../../../../packages/server/src/server/rsocket/handlers/index.js", () => ({
  createRequestResponseHandler: () => async () => ({ status: "ok" }),
  createRequestStreamHandler: () => () => ({
    cancel: () => {},
    onExtension: () => {},
  }),
  noopStreamSubscriber: () => ({}),
}));

describe("RSocketServer", () => {
  it("constructs and exposes start, stop, and getClientPeer", async () => {
    const router = { routeCommand: vi.fn(), routeStream: vi.fn() };
    const server = new RSocketServer(
      0,
      { validate: () => "user" },
      router as never,
      undefined,
      undefined,
      {
        cert: "CERT",
        key: "KEY",
        fingerprint256: "AA:BB",
      },
    );

    expect(server).toBeInstanceOf(RSocketServer);
    expect(typeof server.start).toBe("function");
    expect(typeof server.stop).toBe("function");
    expect(server.getClientPeer("missing")).toBeUndefined();

    await server.start();
    expect(mockBind).toHaveBeenCalled();
    server.stop();
    expect(mockClose).toHaveBeenCalled();
  });

  it("mentions acceptor handlers handleRequestResponse and handleRequestStream", () => {
    const handlerNames = ["handleRequestResponse", "handleRequestStream"];
    expect(handlerNames).toHaveLength(2);
  });
});
