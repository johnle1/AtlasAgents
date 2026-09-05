/**
 * Spawns `examples/mcp-server/dist/http.js` as a real subprocess for the
 * HTTP/SSE system tests, and parses the port it bound.
 *
 * @remarks
 * The example server binds port 0 (OS-assigned) and prints the resolved
 * URL to stderr in a fixed format — see `examples/mcp-server/src/http.ts`.
 * This helper spawns it, waits for that line, and extracts the port so
 * tests never need a fixed port (which would collide across a parallel
 * test matrix).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the built example server's HTTP entry point. */
export const HTTP_ENTRY = path.resolve(__dirname, "../../examples/mcp-server/dist/http.js");

/** Whether the example server has been built (`npm run build` in `examples/mcp-server`). */
export const HTTP_ENTRY_EXISTS = existsSync(HTTP_ENTRY);

const LISTENING_LINE = /listening \((streamable-http|sse)\) on (http:\/\/127\.0\.0\.1:\d+\/mcp)/;

export type McpHttpServerHandle = {
  /** The subprocess itself, for `.kill()` in `afterEach`/`afterAll`. */
  proc: ChildProcess;
  /** The full URL to pass as `/mcp add`'s `--url` (or `McpServerConfig.url`). */
  url: string;
  /**
   * Accumulates every stderr line the server prints — including the
   * `sse-mode: rejecting POST /mcp` line `http.ts` logs each time it turns
   * away a streamable-HTTP probe. Boxed in an object (rather than returned
   * as a plain string) because the string keeps growing after this handle
   * is returned; read `.stderr.text` fresh each time, don't destructure it.
   */
  stderr: { text: string };
};

/**
 * Spawns `dist/http.js`, optionally in `--sse` mode, and resolves once it
 * reports the port it bound.
 *
 * @param mode - `"streamable"` (default, no flag) or `"sse"` (passes `--sse`).
 * @param timeoutMs - How long to wait for the server's startup line before
 *   rejecting — a genuine startup failure (e.g. a port bind error) would
 *   otherwise hang the test until Vitest's own test timeout, with a much
 *   less specific error.
 */
export const startMcpHttpServer = (
  mode: "streamable" | "sse" = "streamable",
  timeoutMs = 5_000,
): Promise<McpHttpServerHandle> =>
  new Promise((resolve, reject) => {
    const proc = spawn("node", [HTTP_ENTRY, ...(mode === "sse" ? ["--sse"] : [])], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timed out waiting for examples/mcp-server dist/http.js (${mode}) to start.`));
    }, timeoutMs);

    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    const stderr = { text: "" };
    let resolved = false;
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr.text += chunk.toString();
      if (!resolved) {
        const match = LISTENING_LINE.exec(stderr.text);
        if (match) {
          resolved = true;
          clearTimeout(timer);
          resolve({ proc, url: match[2]!, stderr });
        }
      }
    });
  });

/** Kills the subprocess and waits for it to actually exit — no orphaned processes between tests. */
export const stopMcpHttpServer = (handle: McpHttpServerHandle): Promise<void> =>
  new Promise((resolve) => {
    if (handle.proc.exitCode !== null || handle.proc.signalCode !== null) {
      resolve();
      return;
    }
    handle.proc.once("exit", () => resolve());
    handle.proc.kill();
  });
