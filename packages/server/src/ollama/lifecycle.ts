/**
 * Manages the Ollama server lifecycle: checks if it's running, and starts `ollama serve` if needed.
 *
 * @remarks
 * On startup, AtlasAgents needs a local Ollama HTTP API available. This module
 * checks if Ollama is already running (by probing its health endpoint). If not,
 * it spawns an `ollama serve` subprocess, waits for it to become reachable, and
 * returns a handle to stop it later.
 *
 * The pattern is clean: call `ensureOllamaRunning()`, get back a handle. If
 * `startedByServer` is true, you own the child process and must call `stop()`
 * to clean it up. If false, Ollama was pre-existing and you should not stop it.
 *
 * This module does NOT register its own process-level signal handlers.
 * Earlier it did, but that meant *any* run where this process started Ollama
 * silently disabled Node's default terminate-on-SIGINT (registering a
 * `'SIGINT'` listener suppresses that default, and this one never called
 * `process.exit()`), so Ctrl+C would kill the Ollama child and then hang
 * forever on the still-open server socket. Signal ownership belongs to the
 * entry point (`server/index.ts`), which retains the handle this module
 * returns and calls `stop()` as one step of its own shutdown sequence.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { TimeoutError } from "../errors/index.js";
import { tuningToEnv, type OllamaTuning } from "./runtimeTuning.js";
import { logger } from "../utils/logger.js";

/** How long to wait between health-check polls (ms). Balances responsiveness vs. CPU load. */
const POLL_INTERVAL_MS = 500;

/** Maximum time to wait for Ollama to become reachable after spawn (ms). */
const STARTUP_TIMEOUT_MS = 30_000;

/**
 * Sleeps for the given milliseconds.
 *
 * @param ms - Duration to sleep.
 * @returns Promise that resolves after the delay.
 *
 * @example
 * ```ts
 * await sleep(1000); // Wait 1 second
 * ```
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probes the Ollama health endpoint to check if the server is reachable.
 *
 * @remarks
 * Attempts to fetch the `/api/tags` endpoint (which lists installed models).
 * If the fetch succeeds and returns HTTP 2xx, Ollama is up. Any error (network,
 * timeout, non-2xx status) means Ollama is not available.
 *
 * @param tagsUrl - Full URL to the `/api/tags` endpoint (e.g. `http://localhost:11434/api/tags`).
 * @returns True if the endpoint responds with 2xx; false if unreachable or error.
 *
 * @example
 * ```ts
 * const isUp = await isOllamaReachable("http://localhost:11434/api/tags");
 * if (isUp) console.log("Ollama is running");
 * ```
 */
const isOllamaReachable = async (tagsUrl: string): Promise<boolean> => {
  try {
    const res = await fetch(tagsUrl, { method: "GET" });
    return res.ok;
  } catch {
    // Network error, timeout, or other failure — Ollama is not reachable.
    return false;
  }
};

/**
 * Polls the Ollama health endpoint until it becomes reachable or timeout expires.
 *
 * @remarks
 * Repeatedly calls `isOllamaReachable()` on an interval until either:
 * 1. The endpoint responds (Ollama is ready), or
 * 2. The timeout deadline passes (startup failed).
 *
 * Used after spawning `ollama serve` to wait for it to bind and accept requests.
 *
 * @param tagsUrl - Health-check URL.
 * @param timeoutMs - Maximum wait time in milliseconds.
 * @throws {@link TimeoutError} if Ollama does not become reachable before the deadline.
 *
 * @example
 * ```ts
 * try {
 *   await waitForOllama("http://localhost:11434/api/tags", 30000);
 *   console.log("Ollama is ready");
 * } catch (err) {
 *   console.log("Ollama failed to start");
 * }
 * ```
 */
const waitForOllama = async (
  tagsUrl: string,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isOllamaReachable(tagsUrl)) {
      return;
    }
    // Not ready yet — sleep before the next probe.
    await sleep(POLL_INTERVAL_MS);
  }
  // Deadline reached without a successful response.
  throw new TimeoutError(
    `Timed out waiting for Ollama at ${tagsUrl} after ${timeoutMs / 1000}s`,
  );
};

/**
 * Handle to control Ollama's lifecycle (only if this server started it).
 *
 * @remarks
 * - `startedByServer`: Whether AtlasAgents spawned the Ollama process. If false,
 *   Ollama was already running, and the caller should NOT stop it.
 * - `stop()`: Kills the child process if this server started it. Safe to call
 *   multiple times (checks if process is already killed).
 */
export type OllamaLifecycle = {
  /** True if AtlasAgents started this Ollama instance and owns the lifecycle. */
  startedByServer: boolean;

  /** Stops the child Ollama process (if this server started it). Safe to call multiple times. */
  stop: () => void;
};

/**
 * Ensures Ollama is running, spawning `ollama serve` if not already available.
 *
 * @remarks
 * The entry point for Ollama lifecycle management. On startup, this function:
 * 1. Checks if Ollama is already running (by probing the health endpoint)
 * 2. If it is, returns a no-op stop handler (Ollama was pre-existing)
 * 3. If it isn't, spawns `ollama serve` as a child process — with the
 *    caller-supplied `tuning` (see `ollama/runtimeTuning.ts`) applied as env
 *    vars, if provided
 * 4. Waits for the child to become reachable (up to 30 seconds)
 * 5. Returns a handle containing a stop function to terminate the child
 *
 * **Important:** The caller owns shutdown — `stop()` only does work if this
 * call spawned the child (`startedByServer: true`), and it is the caller's
 * responsibility to invoke it (typically from its own SIGINT/SIGTERM
 * handler). This module registers no process-level signal handlers itself.
 *
 * @param tagsUrl - Full URL to the `/api/tags` endpoint used for health checks.
 * @param tuning - Runtime tuning to set as env vars when this call spawns
 *   Ollama (see `ollama/runtimeTuning.ts`). Omit for no tuning (existing
 *   behavior). **Only takes effect when this call actually spawns Ollama**
 *   — env vars can't be applied to an already-running process, so on the
 *   early-return path this is used only to log an informational note, never
 *   to alter the pre-existing instance.
 * @returns Lifecycle handle. If `startedByServer` is true, caller must call `stop()` to clean up.
 * @throws {@link Error} if `ollama` command is not found, Ollama exited early, or failed to become reachable.
 * @throws {@link TimeoutError} if startup took longer than 30 seconds.
 *
 * @example
 * ```ts
 * const lifecycle = await ensureOllamaRunning("http://localhost:11434/api/tags");
 *
 * try {
 *   // Use Ollama here
 *   const client = new OllamaClient({ baseUrl: "http://localhost:11434" });
 * } finally {
 *   // Clean up only if this server started it
 *   if (lifecycle.startedByServer) {
 *     lifecycle.stop();
 *   }
 * }
 * ```
 */
export const ensureOllamaRunning = async (
  tagsUrl: string,
  tuning?: OllamaTuning,
): Promise<OllamaLifecycle> => {
  // EARLY RETURN: Ollama is already running — no need to spawn it. The env
  // this process would have set can't retroactively apply to an instance it
  // didn't start, so just let the operator know tuning was skipped.
  if (await isOllamaReachable(tagsUrl)) {
    if (tuning) {
      logger.info(
        "Ollama is already running — runtime tuning (num_parallel, flash " +
          "attention, kv cache type) only applies when this process starts " +
          "Ollama itself, so it was skipped. Quit the existing Ollama and " +
          "let atlas-server start it, or set these in its own environment, " +
          "for the tuning to take effect.",
      );
    }
    return { startedByServer: false, stop: () => {} };
  }

  let child: ChildProcess | null = null;

  try {
    // SPAWN: Start `ollama serve` as a detached child. stdio: "ignore" discards its output.
    // (In a production app, you might want to capture or log its stderr.)
    child = spawn("ollama", ["serve"], {
      detached: false,
      stdio: "ignore",
      env: tuning ? { ...process.env, ...tuningToEnv(tuning) } : process.env,
    });

    // WAIT FOR SPAWN: Wait for the spawn event (process actually started) or an error/exit event.
    // If error or exit fires before spawn, the child failed to start — reject with a helpful message.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        reject(
          new Error(
            `Failed to start Ollama (${err.message}). Install from https://ollama.com`,
          ),
        );
      };
      const onExit = (code: number | null): void => {
        reject(
          new Error(
            `Ollama exited before becoming ready (code ${code ?? "unknown"})`,
          ),
        );
      };

      // Register handlers once; the first event to fire wins.
      child!.once("error", onError);
      child!.once("exit", onExit);
      child!.once("spawn", () => {
        // Process spawned successfully — remove the exit handler (we're past the danger zone)
        // and resolve so we can proceed to health polling.
        child!.removeListener("exit", onExit);
        resolve();
      });
    });

    // HEALTH POLL: Wait for Ollama to become reachable (bind port, initialize, etc.)
    // This can take a few seconds on first startup.
    await waitForOllama(tagsUrl, STARTUP_TIMEOUT_MS);
  } catch (err) {
    // CLEANUP ON FAILURE: Kill the child if spawn succeeded but startup or health check failed.
    child?.kill();
    throw err;
  }

  // STOP: Terminates the child process. Safe to call more than once — checks
  // `child.killed` first. No signal handlers are registered here; the caller
  // owns when this fires (see module remarks).
  const stopChild = (): void => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  };

  return {
    startedByServer: true,
    stop: stopChild,
  };
};
