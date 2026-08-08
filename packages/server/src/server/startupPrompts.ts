/**
 * Interactive stdin prompts shared by the server's `start` flow and its
 * `--password`/`--port` config-repair flow.
 *
 * @remarks
 * Split out of `server/index.ts` so `cli/serverConfigRepair.ts` can reuse
 * them without importing the entry point module (which would create a
 * circular import: `index.ts` → `serverConfigRepair.ts` → `index.ts`).
 *
 * On a non-TTY stdin (piped input, CI, a scripted deploy), `readPasswordAtStartup`
 * reads through the module-level {@link pendingInput} buffer rather than a
 * fresh `readline.Interface` per call — see that constant's doc for why. This
 * matters more here than it once did: a normal `start` now calls it up to
 * twice in a row (server config passphrase, then auth password) with all the
 * answers arriving in one piped chunk, e.g.
 * `printf 'passphrase\npassword\n' | loopy-server start`.
 */

import * as readline from "node:readline";

/**
 * Input read from a non-TTY stdin but not yet consumed by a prompt.
 *
 * @remarks
 * Module-level because stdin is a single shared stream and a chunk read for
 * one prompt routinely contains the answer to the next one too. `readline`
 * cannot be used here for exactly that reason: each `readline.Interface`
 * buffers whatever has arrived and discards the remainder when closed, so a
 * second prompt would block forever on input that was already read and
 * thrown away. Mirrors the client's `utils/maskedPassword.ts`, which hit the
 * same issue first.
 */
let pendingInput = "";

/** Whether stdin has signalled EOF, so no further input can ever arrive. */
let stdinEnded = false;

/**
 * Takes the next complete line out of {@link pendingInput}.
 *
 * @returns The line without its terminator, or null if no full line is buffered.
 */
const takeBufferedLine = (): string | null => {
  const newlineIndex = pendingInput.indexOf("\n");
  if (newlineIndex === -1) {
    return null;
  }
  const line = pendingInput.slice(0, newlineIndex);
  pendingInput = pendingInput.slice(newlineIndex + 1);
  return line;
};

/**
 * Reads one line from a piped (non-TTY) stdin, leaving any extra buffered
 * input in {@link pendingInput} for the next call.
 *
 * @returns The line, with trailing whitespace removed.
 * @throws {Error} When stdin is exhausted, rather than resolving empty
 *   strings forever — a retry loop fed an endless stream of blank answers
 *   would spin without ever telling the operator what went wrong.
 */
const readLineFromPipedStdin = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const buffered = takeBufferedLine();
    if (buffered !== null) {
      resolve(buffered.trimEnd());
      return;
    }

    if (stdinEnded) {
      if (pendingInput.length === 0) {
        reject(new Error("No more input available on stdin."));
        return;
      }
      // A final line with no trailing newline.
      const remainder = pendingInput;
      pendingInput = "";
      resolve(remainder.trimEnd());
      return;
    }

    const stdin = process.stdin;

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.pause();
    };

    const onData = (chunk: string | Buffer): void => {
      pendingInput +=
        typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const line = takeBufferedLine();
      if (line !== null) {
        cleanup();
        resolve(line.trimEnd());
      }
    };

    const onEnd = (): void => {
      stdinEnded = true;
      cleanup();
      if (pendingInput.length === 0) {
        reject(new Error("No more input available on stdin."));
        return;
      }
      const remainder = pendingInput;
      pendingInput = "";
      resolve(remainder.trimEnd());
    };

    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.resume();
  });

/**
 * Prompts for a password/passphrase with masked echo when stdin is a TTY.
 *
 * @remarks
 * In TTY environments, enables raw mode for character-by-character input
 * and displays bullet points (•) instead of actual characters for security.
 * In non-TTY environments (e.g., piped input, CI), reads one line through
 * {@link readLineFromPipedStdin} — not a fresh `readline.Interface`, which
 * would silently discard any already-buffered answers to later prompts.
 *
 * Handles Enter to submit and Backspace to delete. Returns the password
 * as a plain string (may be empty).
 *
 * Reused for every secret this process ever prompts for — the RSocket
 * client-auth password, the server config passphrase, and a repaired
 * password/passphrase entry — hence the configurable `label`. Calling this
 * several times in sequence is supported on both paths, which matters since
 * a normal `start` does exactly that.
 *
 * @param label - Prompt text printed before input; defaults to the
 *   client-auth password prompt.
 * @returns Password/passphrase string entered by the user
 * @throws {Error} On a non-TTY stdin that has run out of input.
 */
export const readPasswordAtStartup = (
  label = "Enter server password: ",
): Promise<string> => {
  const stdout = process.stdout;
  const stdin = process.stdin;

  stdout.write(label);

  // Non-TTY (piped input, CI): read the line directly, since raw mode is
  // unavailable. Not masked — there's no terminal to mask it on — but also
  // not echoed back by this process.
  if (!stdin.isTTY) {
    return readLineFromPipedStdin();
  }

  // TTY environment - use raw mode for character-by-character input with masking
  return new Promise((resolve, reject) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let password = "";

    // Restore TTY state on completion or error
    const cleanup = () => {
      try {
        stdin.removeListener("data", onData);
        stdin.setRawMode(false);
        stdin.pause();
      } catch (error) {
        // Log cleanup errors to stderr for debugging
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        process.stderr.write(`Error restoring TTY state: ${errorMessage}\n`);
      }
    };

    const onData = (chunk: string | Buffer) => {
      try {
        const chunkString =
          typeof chunk === "string" ? chunk : chunk.toString("utf8");

        for (const character of chunkString) {
          const characterCode = character.charCodeAt(0);

          // Enter key or Ctrl-D submits the password
          if (character === "\n" || character === "\r" || characterCode === 4) {
            cleanup();
            stdout.write("\n");
            resolve(password);
            return;
          }

          // Backspace or delete removes the last character
          if (characterCode === 127 || character === "\b") {
            if (password.length > 0) {
              password = password.slice(0, -1);
              stdout.write("\b \b"); // Move back, overwrite with space, move back again
            }
            continue;
          }

          // Regular character - add to password and display bullet point
          password += character;
          stdout.write("•");
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    try {
      stdin.on("data", onData);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
};

/**
 * Parses a port prompt's raw answer, defaulting to 7000 on empty or invalid input.
 */
const parsePortAnswer = (answer: string): number => {
  const trimmedAnswer = answer.trim();

  // Empty input uses default port
  if (trimmedAnswer.length === 0) {
    return 7000;
  }

  const parsedPort = parseInt(trimmedAnswer, 10);

  // Validate port is within valid TCP range (1-65535)
  if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    return 7000; // Invalid input falls back to default
  }

  return parsedPort;
};

/** Prompt text for {@link promptListenPort}. */
const PORT_PROMPT = "Enter port (default 7000): ";

/**
 * Prompts for TCP listen port with default 7000 when input is empty or invalid.
 *
 * @remarks
 * Validates that the port is within the valid TCP port range (1-65535).
 * If the input is empty, not a number, or out of range, returns the default
 * port 7000. This provides a safe fallback for invalid user input.
 *
 * On a non-TTY stdin, reads through the same {@link readLineFromPipedStdin}
 * buffer as {@link readPasswordAtStartup} — not its own `readline.Interface`,
 * which would only see bytes that arrive *after* it's created and so miss
 * anything already sitting in the shared buffer from an earlier prompt (this
 * is routinely the case: `start` calls this right after one or two password
 * prompts, all fed from one piped chunk). On a TTY, still uses `readline` for
 * its line-editing (backspace, etc.) on a plain, unmasked port number.
 *
 * On the TTY path {@link PORT_PROMPT} must be passed to `question()` rather
 * than written to stdout beforehand: a terminal-mode `Interface` refreshes
 * the line as soon as `question()` runs, emitting `ESC[1G ESC[0J` (cursor to
 * column 1, erase to end of display) and redrawing only the text it owns. A
 * prompt written first is therefore wiped off screen before the operator can
 * read it, leaving `start` looking hung on a blank line with no hint that it
 * is waiting for a port. The password prompts above are immune because they
 * drive raw mode directly and never hand the line to `readline`.
 *
 * @returns Valid port number in range 1-65535
 * @throws {Error} On a non-TTY stdin that has run out of input.
 */
export const promptListenPort = (): Promise<number> => {
  const stdout = process.stdout;
  const stdin = process.stdin;

  // No terminal to redraw the line, so writing the prompt directly is both
  // safe and the only way it reaches the operator's log.
  if (!stdin.isTTY) {
    stdout.write(PORT_PROMPT);
    return readLineFromPipedStdin().then(parsePortAnswer);
  }

  const readlineInterface = readline.createInterface({
    input: stdin,
    output: stdout,
  });

  return new Promise((resolve) => {
    readlineInterface.question(PORT_PROMPT, (answer) => {
      readlineInterface.close();
      resolve(parsePortAnswer(answer));
    });
  });
};
