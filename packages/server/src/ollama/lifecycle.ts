/**
 * Manages the Ollama server lifecycle: checks if it's running, and starts `ollama serve` if needed.
 *
 * @remarks
 * On startup, LoopyCode needs a local Ollama HTTP API available. This module
 * checks if Ollama is already running (by probing its health endpoint). If not,
 * it spawns an `ollama serve` subprocess, waits for it to become reachable, and
 * returns a handle to stop it later.
 *
 * The pattern is clean: call `ensureOllamaRunning()`, get back a handle. If
 * `startedByServer` is true, you own the child process and must call `stop()`
 * to clean it up. If false, Ollama was pre-existing and you should not stop it.
 *
 * Signal handlers (SIGINT, SIGTERM) are registered to ensure the child process
 * is killed even if the node process exits unexpectedly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { TimeoutError } from "../errors/index.js";

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
 * - `startedByServer`: Whether LoopyCode spawned the Ollama process. If false,
 *   Ollama was already running, and the caller should NOT stop it.
 * - `stop()`: Kills the child process if this server started it. Safe to call
 *   multiple times (checks if process is already killed).
 */
export type OllamaLifecycle = {
  /** True if LoopyCode started this Ollama instance and owns the lifecycle. */
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
 * 3. If it isn't, spawns `ollama serve` as a child process
 * 4. Waits for the child to become reachable (up to 30 seconds)
 * 5. Registers signal handlers (SIGINT, SIGTERM) to ensure the child is killed on exit
 * 6. Returns a handle containing a stop function to terminate the child
 *
 * **Important:** Signal handlers are registered even if Ollama was pre-existing,
 * but the stop() function only does work if this call spawned the child.
 *
 * @param tagsUrl - Full URL to the `/api/tags` endpoint used for health checks.
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
): Promise<OllamaLifecycle> => {
  // EARLY RETURN: Ollama is already running — no need to spawn it.
  if (await isOllamaReachable(tagsUrl)) {
    return { startedByServer: false, stop: () => {} };
  }

  let child: ChildProcess | null = null;

  try {
    // SPAWN: Start `ollama serve` as a detached child. stdio: "ignore" discards its output.
    // (In a production app, you might want to capture or log its stderr.)
    child = spawn("ollama", ["serve"], {
      detached: false,
      stdio: "ignore",
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

  // SIGNAL HANDLING: Register handlers to ensure the child is killed on graceful shutdown.
  // This protects against orphaned `ollama serve` processes if the node process exits.
  const stopChild = (): void => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  };

  const onSignal = (): void => {
    stopChild();
  };

  // Register signal handlers. Using `once` ensures we only listen for the FIRST signal.
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  return {
    startedByServer: true,
    stop: () => {
      // DEREGISTER: Remove signal handlers so they don't fire after we've cleaned up.
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      // KILL: Terminate the child process.
      stopChild();
    },
  };
};
