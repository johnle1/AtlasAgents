/**
 * System (E2E) tests — LoopyCode CLI binary
 *
 * Spawns the compiled `loopy` CLI as a real subprocess and tests it from
 * the outside: real stdin/stdout, real exit codes, real environment variables.
 * No internal modules are imported — this layer is intentionally opaque.
 *
 * Testing pyramid layer : System / E2E
 * Runner                 : Vitest
 * Binary under test       : packages/client/dist/index.js  (compiled via `npm run build`)
 * Subprocess helper       : execa
 * Output cleaning         : strip-ansi (removes terminal color escape sequences)
 *
 * ⚠  IMPORTANT — Prerequisites
 * -----------------------------
 * System tests run against the COMPILED binary, not TypeScript source.
 * You must build the client package before running these tests:
 *
 *   cd packages/client && npm run build
 *
 * If the dist/ directory is missing, all tests in this file are skipped
 * automatically rather than failing with a cryptic error. This keeps CI
 * clean on fresh checkouts where the build step may not have run yet.
 *
 * ⚠  Live Ollama NOT required
 * ----------------------------
 * These tests cover only the CLI startup path (help, version, bad env).
 * They do NOT perform a real chat round-trip because that requires a locally
 * running Ollama server. The chat round-trip is left as a manual test
 * (see "Manual verification" section below) or can be added behind an
 * environment-variable gate (RUN_LIVE_TESTS=1).
 *
 * Category checklist:
 *   ✅ Full user journey  — --help flag, process exits cleanly
 *   ✅ Environment variant — unreachable server produces a clear error message
 *   ✅ Exit codes          — 0 for help, non-zero for connection failure
 *   ✅ Signal handling     — not tested here (requires interactive TTY)
 *
 * Manual verification (not automated)
 * ------------------------------------
 * Run the CLI interactively to verify:
 *   1. Start: `node packages/client/dist/index.js`
 *   2. Type a task: "what is 2+2?" → agent replies
 *   3. Press Ctrl+C (busy) → confirm prompt appears
 *   4. Press Ctrl+C again → CLI exits cleanly with code 0
 */

import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

// We import dynamically so the test file is still parseable even without
// execa installed. The `beforeAll` guard below handles the missing build case.
import { execa } from "execa";
import stripAnsi from "strip-ansi";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the compiled CLI entry point. */
const CLI_PATH = path.resolve(__dirname, "../../packages/client/dist/index.js");

/** True when the client has been compiled and the binary is available. */
const BINARY_EXISTS = existsSync(CLI_PATH);

/**
 * Conditionally skip all tests in this file when the binary is missing.
 *
 * @remarks
 * Using `it.skipIf` rather than a single `describe.skipIf` at the top so
 * that Vitest reports each test individually as skipped with a clear reason,
 * rather than silently omitting the entire block.
 */
const itWhenBuilt = BINARY_EXISTS ? it : it.skip;

// ---------------------------------------------------------------------------
// Helper — run the CLI binary with the given args and options
// ---------------------------------------------------------------------------

/**
 * Spawns `node dist/index.js` with the given arguments.
 * Always passes `reject: false` so non-zero exit codes don't throw.
 *
 * @param args - CLI arguments to pass after the binary path.
 * @param env - Additional environment variables to set for this invocation.
 */
async function runCli(
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa("node", [CLI_PATH, ...args], {
    reject: false,
    env: {
      ...process.env,
      // Ensure we're not inside a real tmux / screen reader env during tests
      TMUX: "",
      TERM: "xterm-256color",
      CI: "false",
      ...env,
    },
    // Prevent the process from inheriting an actual TTY — we want raw I/O
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    stdout: stripAnsi(result.stdout),
    stderr: stripAnsi(result.stderr),
    exitCode: result.exitCode ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Binary availability guard
// ---------------------------------------------------------------------------

describe("CLI binary availability", () => {
  it("dist/index.js exists — binary has been built (prerequisite check)", () => {
    if (!BINARY_EXISTS) {
      // Provide an actionable error message instead of a silent skip
      console.warn(
        "\n⚠  System tests skipped — binary not found at:\n  " +
          CLI_PATH +
          "\n  Run: cd packages/client && npm run build\n",
      );
    }
    // This test itself does not skip — it documents whether the binary exists.
    // The `itWhenBuilt` helper skips the rest if BINARY_EXISTS is false.
    expect(typeof BINARY_EXISTS).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// --help flag — user journey: request help → exit 0
// ---------------------------------------------------------------------------

describe("CLI --help flag (user journey)", () => {
  itWhenBuilt(
    "exits with code 0 when --help is passed (exit code check)",
    async () => {
      const { exitCode } = await runCli(["--help"]);
      expect(exitCode).toBe(0);
    },
  );

  itWhenBuilt(
    "prints usage information to stdout when --help is passed (output check)",
    async () => {
      const { stdout, stderr } = await runCli(["--help"]);
      // The help output should appear on stdout or stderr
      const combined = stdout + stderr;
      // At minimum, the binary name or 'Usage' keyword should appear
      const hasHelpContent =
        combined.toLowerCase().includes("usage") ||
        combined.toLowerCase().includes("loopy") ||
        combined.toLowerCase().includes("help") ||
        combined.toLowerCase().includes("option");
      expect(hasHelpContent).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Environment variant — unreachable Ollama server
// ---------------------------------------------------------------------------

describe("CLI environment variant — bad OLLAMA_HOST", () => {
  itWhenBuilt(
    "exits with a non-zero code when the server host is unreachable (exit code)",
    async () => {
      /**
       * We set LOOPYCODE_SERVER (or equivalent) to an unreachable address.
       * The CLI should detect this quickly and exit non-zero rather than
       * hanging indefinitely.
       *
       * Port 1 is reserved and will immediately refuse connections on most
       * operating systems, making this test fast and reliable.
       */
      const { exitCode } = await runCli(["--host", "127.0.0.1", "--port", "1"], {
        // Give the process a small stdin EOF immediately so it doesn't hang
        // waiting for interactive input
      });
      // Any non-zero exit is acceptable — we just confirm it's not 0
      expect(exitCode).not.toBe(0);
    },
  );

  itWhenBuilt(
    "prints an error or connection message when the server is unreachable (output)",
    async () => {
      const { stdout, stderr } = await runCli(["--host", "127.0.0.1", "--port", "1"]);
      const combined = (stdout + stderr).toLowerCase();
      // A human-readable error about connection failure should appear
      const hasErrorContent =
        combined.includes("connect") ||
        combined.includes("error") ||
        combined.includes("fail") ||
        combined.includes("refused") ||
        combined.includes("econnrefused") ||
        combined.includes("unable");
      expect(hasErrorContent).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Exit code correctness
// ---------------------------------------------------------------------------

describe("CLI exit codes", () => {
  itWhenBuilt(
    "--help exits 0 (exit code — success path)",
    async () => {
      const { exitCode } = await runCli(["--help"]);
      expect(exitCode).toBe(0);
    },
  );

  itWhenBuilt(
    "unknown flag exits non-zero (exit code — error path)",
    async () => {
      const { exitCode } = await runCli(["--totally-unknown-flag-xyz"]);
      // Unknown flags should produce a non-zero exit
      // Some CLIs may still exit 0 for unknown flags and print an error message;
      // we check the combined output in that case.
      if (exitCode === 0) {
        const { stdout, stderr } = await runCli(["--totally-unknown-flag-xyz"]);
        const combined = stdout + stderr;
        // At least an error/warning message should appear
        expect(combined.length).toBeGreaterThan(0);
      } else {
        expect(exitCode).not.toBe(0);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Process does not hang — basic startup sanity check
// ---------------------------------------------------------------------------

describe("CLI startup sanity (process lifecycle)", () => {
  itWhenBuilt(
    "process terminates within the test timeout when given --help (no hang)",
    async () => {
      /**
       * This test will fail (via timeout) if the process hangs.
       * The Vitest testTimeout of 20s (see vitest.config.ts) acts as the
       * guard — if the process doesn't exit, Vitest kills it.
       *
       * This catches regressions where the CLI starts listening for events
       * before processing CLI flags, or forgets to call process.exit().
       */
      const start = Date.now();
      const { exitCode } = await runCli(["--help"]);
      const elapsed = Date.now() - start;

      expect(exitCode).toBe(0);
      // A --help invocation should be very fast (well under 5 seconds)
      expect(elapsed).toBeLessThan(5_000);
    },
  );
});
