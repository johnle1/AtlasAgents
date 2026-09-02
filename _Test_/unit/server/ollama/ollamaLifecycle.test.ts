/**
 * Unit tests — ollama/lifecycle.ts ensureOllamaRunning
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const loggerInfoMock = vi.fn();
vi.mock("../../../../packages/server/src/utils/logger.js", () => ({
  logger: { info: (...args: unknown[]) => loggerInfoMock(...args) },
}));

import { ensureOllamaRunning } from "../../../../packages/server/src/ollama/lifecycle.js";

/**
 * A fake ChildProcess that emits "spawn" once something is listening.
 *
 * @remarks
 * Scheduling the emit here — invoked by `spawnMock`'s own implementation, at
 * the moment `spawn()` is actually called by the code under test — matters:
 * `ensureOllamaRunning` attaches its `.once("spawn", ...)` listener
 * synchronously, in the same tick as the `spawn()` call, so queuing the
 * emit from inside the mock's call keeps it strictly after that listener is
 * attached. Scheduling it earlier (e.g. at test-setup time, before
 * `ensureOllamaRunning` even runs) would fire the event before anything is
 * listening, since several `await`s happen in between — the event would be
 * lost and the call would hang until the real 30s startup timeout.
 */
const makeFakeChild = (): EventEmitter & { kill: ReturnType<typeof vi.fn>; killed: boolean } => {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.kill = vi.fn(() => {
    child.killed = true;
  });
  child.killed = false;
  return child;
};

describe("ensureOllamaRunning", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    spawnMock.mockReset();
    loggerInfoMock.mockReset();
  });

  it("returns startedByServer false when Ollama already responds (normal)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const lifecycle = await ensureOllamaRunning("http://127.0.0.1:11434/api/tags");
    expect(lifecycle.startedByServer).toBe(false);
    lifecycle.stop();
    expect(fetch).toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("logs an informational note (not a spawn) when Ollama is already running and tuning was supplied (normal)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    await ensureOllamaRunning("http://127.0.0.1:11434/api/tags", {
      numParallel: 4,
      flashAttention: true,
      kvCacheType: "q8_0",
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledTimes(1);
    expect(loggerInfoMock.mock.calls[0]![0]).toMatch(/already running/i);
  });

  it("does not log anything when Ollama is already running and no tuning was supplied (regression guard — existing callers unaffected)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    await ensureOllamaRunning("http://127.0.0.1:11434/api/tags");

    expect(loggerInfoMock).not.toHaveBeenCalled();
  });

  it("spawns ollama with the tuning rendered as env vars, merged over the inherited environment (normal)", async () => {
    let probeCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        probeCount += 1;
        // First probe (the reachability pre-check): not reachable yet, so
        // ensureOllamaRunning proceeds to spawn. Every probe after that
        // (waitForOllama's polling) succeeds.
        return { ok: probeCount > 1 };
      }),
    );

    const fakeChild = makeFakeChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeChild.emit("spawn"));
      return fakeChild;
    });

    const lifecycle = await ensureOllamaRunning(
      "http://127.0.0.1:11434/api/tags",
      { numParallel: 3, flashAttention: false, kvCacheType: "f16" },
    );

    expect(lifecycle.startedByServer).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0]!;
    expect(command).toBe("ollama");
    expect(args).toEqual(["serve"]);
    expect((options as { env: Record<string, string> }).env).toMatchObject({
      OLLAMA_NUM_PARALLEL: "3",
      OLLAMA_FLASH_ATTENTION: "0",
      OLLAMA_KV_CACHE_TYPE: "f16",
    });
    // Merged over, not replacing, the inherited environment.
    expect((options as { env: Record<string, string> }).env.PATH).toBe(
      process.env.PATH,
    );
  });

  it("spawns ollama with the plain inherited environment when no tuning is supplied (regression guard)", async () => {
    let probeCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        probeCount += 1;
        return { ok: probeCount > 1 };
      }),
    );

    const fakeChild = makeFakeChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => fakeChild.emit("spawn"));
      return fakeChild;
    });

    await ensureOllamaRunning("http://127.0.0.1:11434/api/tags");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , options] = spawnMock.mock.calls[0]!;
    expect((options as { env: unknown }).env).toBe(process.env);
  });
});
