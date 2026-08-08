/**
 * Integration tests — TLS 1.3 client/server RSocket handshake with TOFU
 * fingerprint pinning.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : createTlsServerTransport, createTlsClientTransport,
 *                          loadOrCreateServerCert, @rsocket/core,
 *                          @rsocket/tcp-server, @rsocket/tcp-client — a real
 *                          TCP socket pair on 127.0.0.1, real TLS 1.3
 *                          handshake, real RSocket requestResponse.
 * Mocks                  : none. The only substitution is an in-memory
 *                          fingerprint map in place of fingerprintStore.ts's
 *                          disk-backed one (that module's own logic — TOFU
 *                          pin/match/mismatch — is covered by
 *                          _Test_/unit/fingerprintStore.test.ts; this file's
 *                          job is proving the wire-level shim actually works
 *                          end-to-end, which no unit test can do without a
 *                          real socket).
 *
 * What this test catches that unit tests miss
 * --------------------------------------------
 *   - The server-side shim (redirect "connection" → "secureConnection") and
 *     the client-side shim (Proxy + gated "connect" queue) actually
 *     interoperate over a real socket — a subtly wrong event name or a
 *     monkey-patch that collides with Node's own internals (see the bug
 *     documented in tlsClientTransport.ts's module doc) would hang or
 *     silently fall back to broken behavior; nothing in the unit-tested
 *     modules alone can prove the transports actually connect.
 *   - A rejected fingerprint genuinely prevents any RSocket frame from being
 *     exchanged, not just that the reject callback fires.
 *   - TLS 1.3 is actually enforced end-to-end, not just requested in options.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { RSocketServer as RSocketServerCore, RSocketConnector } from "@rsocket/core";
import { createTlsServerTransport } from "../../../packages/server/src/server/tls/tlsServerTransport.js";
import { loadOrCreateServerCert } from "../../../packages/server/src/server/tls/certificateStore.js";
import { createTlsClientTransport } from "../../../packages/client/src/connection/tls/tlsClientTransport.js";

let nextPort = 58500;
const closeables: Array<{ close: () => void }> = [];
const tempRoots: string[] = [];

afterEach(async () => {
  for (const closeable of closeables.splice(0)) {
    closeable.close();
  }
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

/** Starts a real TLS 1.3 RSocket server that echoes back what it's sent. */
const startEchoServer = async (): Promise<{
  port: number;
  fingerprint256: string;
  requestCount: () => number;
}> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-tls-integration-"));
  tempRoots.push(root);
  const cert = await loadOrCreateServerCert(root);

  let requests = 0;
  const port = nextPort++;
  const transport = createTlsServerTransport({ host: "127.0.0.1", port }, cert);
  const server = new RSocketServerCore({
    transport,
    acceptor: {
      accept: async () => ({
        requestResponse: (payload, responderStream) => {
          requests += 1;
          responderStream.onNext({ data: payload.data }, true);
          return { cancel: () => {}, onExtension: () => {} };
        },
      }),
    },
  });
  const closeable = await server.bind();
  closeables.push(closeable);

  return { port, fingerprint256: cert.fingerprint256, requestCount: () => requests };
};

/** Sends one requestResponse over a fresh TLS client connection and returns the reply. */
const connectAndPing = async (
  port: number,
  onCertificate: (fingerprint256: string) => "trust" | "reject",
): Promise<string> => {
  const transport = createTlsClientTransport({ host: "127.0.0.1", port, onCertificate });
  const connector = new RSocketConnector({
    transport,
    setup: { dataMimeType: "application/json", metadataMimeType: "application/json" },
  });
  const rsocket = await connector.connect();
  try {
    return await new Promise<string>((resolve, reject) => {
      rsocket.requestResponse(
        { data: Buffer.from("ping") },
        {
          onNext: (payload) => resolve(payload.data?.toString() ?? ""),
          onError: reject,
          onComplete: () => {},
          onExtension: () => {},
        },
      );
    });
  } finally {
    rsocket.close();
  }
};

describe("TLS 1.3 RSocket handshake — trusted fingerprint", () => {
  it("completes a full request/response round trip over a real TLS 1.3 socket", async () => {
    const { port } = await startEchoServer();
    const reply = await connectAndPing(port, () => "trust");
    expect(reply).toBe("ping");
  });

  it("presents the same certificate fingerprint the server reports", async () => {
    const { port, fingerprint256 } = await startEchoServer();
    let observed: string | undefined;
    await connectAndPing(port, (fp) => {
      observed = fp;
      return "trust";
    });
    expect(observed).toBe(fingerprint256);
  });
});

describe("TLS 1.3 RSocket handshake — rejected fingerprint", () => {
  it("rejects connect() and never lets a frame reach the server", async () => {
    const { port, requestCount } = await startEchoServer();

    await expect(connectAndPing(port, () => "reject")).rejects.toThrow();
    expect(requestCount()).toBe(0);
  });
});

describe("TLS 1.3 RSocket handshake — protocol version enforcement", () => {
  it("rejects a TLS 1.2-only client", async () => {
    const { port } = await startEchoServer();

    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = tls.connect({
          host: "127.0.0.1",
          port,
          minVersion: "TLSv1.2",
          maxVersion: "TLSv1.2",
          rejectUnauthorized: false,
        });
        socket.once("secureConnect", () => {
          socket.destroy();
          reject(new Error("TLS 1.2 handshake unexpectedly succeeded"));
        });
        socket.once("error", () => {
          resolve();
        });
      }),
    ).resolves.toBeUndefined();
  });
});
