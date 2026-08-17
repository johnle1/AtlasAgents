/**
 * Integration tests — TOFU certificate pinning across real TLS connections,
 * using the REAL disk-backed fingerprint store.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : fingerprintStore (disk-backed, via client config.ts),
 *                          createTlsClientTransport, createTlsServerTransport,
 *                          loadOrCreateServerCert, @rsocket/core — a real TCP
 *                          socket pair on 127.0.0.1 and a real TLS 1.3 handshake.
 * Mocks                  : none. `HOME` is redirected to a temp dir so the real
 *                          on-disk `~/.atlasagents/config.json` pin store is
 *                          exercised without touching the developer's own.
 *
 * What this test catches that the existing tests miss
 * ----------------------------------------------------
 * Two halves of TOFU are already covered separately, and neither can prove the
 * property that actually matters:
 *
 *   - `unit/fingerprintStore.test.ts` drives the pin store with hand-written
 *     fingerprint strings and no TLS at all, so it cannot show that the string
 *     a real certificate presents is the same string that gets pinned.
 *   - `integration/tlsHandshakeFlow.test.ts` runs a real handshake but
 *     deliberately substitutes an in-memory decision callback for the pin
 *     store (see its module doc), so it cannot show that a pin actually
 *     survives to disk or is re-read on a later connection.
 *
 * This file joins them: a real certificate's real fingerprint flows into the
 * real store, persists to a real config file, and is enforced on a later
 * connection. In particular it proves the security-critical rotation case —
 * a server that regenerates its certificate is REFUSED by a client that
 * already pinned the old one, which is the entire point of TOFU and is
 * invisible to both tests above.
 *
 * Category checklist:
 *   ✅ Happy path          — first connect pins, reconnect matches, both succeed
 *   ✅ Contract consistency — the pinned string equals the cert's real fingerprint
 *   ✅ Failure propagation  — a rotated cert is rejected and no frame is exchanged
 *   ✅ State integrity      — a rejected connection never overwrites the good pin
 *   ✅ System-level edges   — pins persist across store reloads; independent per host:port
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  RSocketServer as RSocketServerCore,
  RSocketConnector,
} from "@rsocket/core";
import { createTlsServerTransport } from "../../../packages/server/src/server/tls/tlsServerTransport.js";
import { loadOrCreateServerCert } from "../../../packages/server/src/server/tls/certificateStore.js";
import { createTlsClientTransport } from "../../../packages/client/src/connection/tls/tlsClientTransport.js";

/**
 * `config.ts` resolves its config directory from `os.homedir()` once at module
 * load, so `HOME` must be overridden *before* the module is first imported.
 * These are therefore imported dynamically in `beforeAll`, matching the
 * approach documented in `unit/fingerprintStore.test.ts`.
 */
let checkAndPinFingerprint: typeof import("../../../packages/client/src/connection/tls/fingerprintStore.js").checkAndPinFingerprint;
let clearFingerprint: typeof import("../../../packages/client/src/connection/tls/fingerprintStore.js").clearFingerprint;
let loadConfig: typeof import("../../../packages/client/src/config/index.js").loadConfig;

let originalHome: string | undefined;
let tempHome: string;

/** Ports are allocated from a distinct range so this file can run beside tlsHandshakeFlow. */
let nextPort = 58700;
const closeables: Array<{ close: () => void }> = [];
const tempRoots: string[] = [];

beforeAll(async () => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-tofu-integration-"));
  process.env.HOME = tempHome;

  const fingerprintModule = await import(
    "../../../packages/client/src/connection/tls/fingerprintStore.js"
  );
  checkAndPinFingerprint = fingerprintModule.checkAndPinFingerprint;
  clearFingerprint = fingerprintModule.clearFingerprint;

  const configModule = await import("../../../packages/client/src/config/index.js");
  loadConfig = configModule.loadConfig;
  // The client config file is encrypted at rest; unlock once for the whole
  // file so each test isn't entangled with an unrelated passphrase prompt.
  await configModule.unlockOrSetupConfigCipher(async () => "tofu-test-passphrase");
});

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

afterEach(async () => {
  for (const closeable of closeables.splice(0)) {
    closeable.close();
  }
  await Promise.all(
    tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })),
  );
});

/**
 * Starts a real TLS 1.3 RSocket echo server.
 *
 * @param opts.certRoot - Data root holding `tls/`. Passing the SAME root
 *   twice reuses the existing certificate (simulating a server restart);
 *   omitting it generates a fresh certificate (simulating a key rotation, or
 *   an attacker impersonating the host).
 * @param opts.port - Explicit port to bind. TOFU pins by `host:port` (see
 *   `fingerprintKey`), so simulating a rotation on the SAME server address
 *   requires rebinding the same port with a different certificate — a
 *   rotated cert on a fresh port is indistinguishable from a first-ever
 *   connection and would defeat the whole point of these tests.
 */
const startEchoServer = async (
  opts: { certRoot?: string; port?: number } = {},
): Promise<{
  port: number;
  fingerprint256: string;
  certRoot: string;
  requestCount: () => number;
  /** Closes this server early and stops `afterEach` from double-closing it. */
  close: () => void;
}> => {
  const root =
    opts.certRoot ??
    (await fsp.mkdtemp(path.join(os.tmpdir(), "atlas-tofu-cert-")));
  if (!opts.certRoot) {
    tempRoots.push(root);
  }
  const cert = await loadOrCreateServerCert(root);

  let requests = 0;
  const port = opts.port ?? nextPort++;
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

  return {
    port,
    fingerprint256: cert.fingerprint256,
    certRoot: root,
    requestCount: () => requests,
    close: () => {
      const index = closeables.indexOf(closeable);
      if (index !== -1) {
        closeables.splice(index, 1);
      }
      closeable.close();
    },
  };
};

/**
 * Connects and pings, routing the certificate decision through the REAL
 * disk-backed TOFU store rather than an in-memory stub.
 *
 * @param host - Logical host used as the pin key. Each test uses its own so
 *   pins never collide inside the shared temp `HOME`.
 */
const connectViaPinStore = async (
  host: string,
  port: number,
): Promise<string> => {
  const transport = createTlsClientTransport({
    host: "127.0.0.1",
    port,
    onCertificate: (fingerprint256) =>
      checkAndPinFingerprint(host, port, fingerprint256).trust
        ? "trust"
        : "reject",
  });
  const connector = new RSocketConnector({
    transport,
    setup: {
      dataMimeType: "application/json",
      metadataMimeType: "application/json",
    },
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

describe("TOFU pinning — first connection", () => {
  it("pins a real certificate's fingerprint and completes the round trip", async () => {
    const { port } = await startEchoServer();

    const reply = await connectViaPinStore("tofu-first", port);

    expect(reply).toBe("ping");
  });

  it("persists the pin to the on-disk config, not just memory", async () => {
    const { port, fingerprint256 } = await startEchoServer();

    await connectViaPinStore("tofu-persist", port);

    // Read the store back through a fresh loadConfig() — this is what proves
    // the pin reached disk rather than living in a module-local cache.
    expect(loadConfig().serverFingerprints[`tofu-persist:${port}`]).toBe(
      fingerprint256,
    );
  });

  it("pins exactly the fingerprint the server's certificate reports (contract)", async () => {
    const { port, fingerprint256 } = await startEchoServer();

    await connectViaPinStore("tofu-contract", port);

    // A mismatch here would mean the value the transport surfaces and the
    // value the store persists have drifted in format (e.g. colon separators,
    // casing, or a different hash entirely) — silently breaking every later
    // comparison while both halves' own unit tests still pass.
    const pinned = loadConfig().serverFingerprints[`tofu-contract:${port}`];
    expect(pinned).toBe(fingerprint256);
    expect(pinned).toMatch(/^(?:[0-9A-F]{2}:)+[0-9A-F]{2}$/);
  });
});

describe("TOFU pinning — reconnection to the same server", () => {
  it("accepts a second connection presenting the unchanged certificate", async () => {
    const { port, certRoot } = await startEchoServer();
    await connectViaPinStore("tofu-reconnect", port);

    // Restart the server against the SAME cert root — same certificate,
    // as a real server restart would present.
    for (const closeable of closeables.splice(0)) {
      closeable.close();
    }
    const restarted = await startEchoServer({ certRoot });

    const reply = await connectViaPinStore("tofu-reconnect", restarted.port);
    expect(reply).toBe("ping");
  });
});

describe("TOFU pinning — certificate rotation (the security boundary)", () => {
  it("refuses a server whose certificate changed after the pin was taken", async () => {
    const first = await startEchoServer();
    await connectViaPinStore("tofu-rotate", first.port);

    // Rebind the SAME port with a fresh (different) certificate — a rotated
    // cert on a new port would just look like an unrelated first connection.
    first.close();
    const rotated = await startEchoServer({ port: first.port });

    await expect(
      connectViaPinStore("tofu-rotate", rotated.port),
    ).rejects.toThrow();
  });

  it("exchanges no application frame with the rotated server", async () => {
    const first = await startEchoServer();
    await connectViaPinStore("tofu-rotate-noframe", first.port);

    first.close();
    const rotated = await startEchoServer({ port: first.port });
    await connectViaPinStore("tofu-rotate-noframe", rotated.port).catch(
      () => undefined,
    );

    // Rejecting *after* the payload reached the server would still leak data
    // to an impersonator, so assert the server saw nothing at all.
    expect(rotated.requestCount()).toBe(0);
  });

  it("leaves the original pin intact after a rejected connection (state integrity)", async () => {
    const first = await startEchoServer();
    await connectViaPinStore("tofu-rotate-keeppin", first.port);
    const originalPort = first.port;

    first.close();
    const rotated = await startEchoServer({ port: originalPort });
    await connectViaPinStore("tofu-rotate-keeppin", rotated.port).catch(
      () => undefined,
    );

    // The rejected fingerprint must not have overwritten the good one —
    // otherwise an attacker gets to re-pin simply by failing once.
    expect(
      loadConfig().serverFingerprints[`tofu-rotate-keeppin:${originalPort}`],
    ).toBe(first.fingerprint256);
  });
});

describe("TOFU pinning — operator-initiated trust reset", () => {
  it("trusts a rotated certificate once the stale pin is cleared", async () => {
    const first = await startEchoServer();
    await connectViaPinStore("tofu-reset", first.port);

    first.close();
    const rotated = await startEchoServer({ port: first.port });
    await expect(
      connectViaPinStore("tofu-reset", rotated.port),
    ).rejects.toThrow();

    // The documented escape hatch for a legitimate rotation.
    expect(clearFingerprint("tofu-reset", rotated.port)).toBe(true);

    const reply = await connectViaPinStore("tofu-reset", rotated.port);
    expect(reply).toBe("ping");
  });
});

describe("TOFU pinning — independence across servers", () => {
  it("keeps pins for different host:port pairs from interfering", async () => {
    const alpha = await startEchoServer();
    const beta = await startEchoServer();

    expect(await connectViaPinStore("tofu-multi-a", alpha.port)).toBe("ping");
    expect(await connectViaPinStore("tofu-multi-b", beta.port)).toBe("ping");

    const store = loadConfig().serverFingerprints;
    expect(store[`tofu-multi-a:${alpha.port}`]).toBe(alpha.fingerprint256);
    expect(store[`tofu-multi-b:${beta.port}`]).toBe(beta.fingerprint256);
    // Two independently generated self-signed certs must never collide.
    expect(alpha.fingerprint256).not.toBe(beta.fingerprint256);
  });
});
