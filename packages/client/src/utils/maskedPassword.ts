/**
 * Input read from a non-TTY stdin but not yet consumed by a prompt.
 *
 * @remarks
 * Module-level because stdin is a single shared stream and a chunk read for one
 * prompt routinely contains the answers to later ones. `readline` cannot be
 * used here for exactly that reason: each interface buffers whatever has
 * arrived, and closing it discards the remainder — so a second prompt would
 * block forever on input that had already been read and thrown away.
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
 * Reads one line from a piped (non-TTY) stdin.
 *
 * @remarks
 * Leaves any extra buffered input in {@link pendingInput} for the next call and
 * pauses stdin when idle, so a later consumer — the Ink TUI, for instance — can
 * take over the stream cleanly.
 *
 * @returns The line, with trailing whitespace removed.
 * @throws {Error} When stdin is exhausted, rather than resolving empty strings
 *   forever: a prompt loop fed an endless stream of blank answers would spin
 *   without ever telling the user what went wrong.
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
 * Reads one password line from stdin, masking each keystroke with a bullet point on interactive terminals.
 *
 * @remarks
 * This function provides secure password input by masking typed characters with `•` on TTY terminals.
 * In non-TTY environments (e.g., piped input or CI), it reads the line directly since raw mode
 * is unavailable.
 *
 * **Behavior:**
 * - TTY: Enables raw keyboard mode to intercept individual keystrokes. Each printable character
 *   appends to the password and prints `•`. Backspace removes the last character and bullet.
 *   Enter or Ctrl+D submits the password.
 * - Non-TTY: Reads one line from stdin, keeping any further buffered input for the next call.
 *   The line is trimmed of trailing whitespace before returning.
 *
 * Calling this several times in sequence is supported on both paths — which matters, because
 * the passphrase retry loop and the `--password` repair flow both prompt more than once.
 *
 * **Important:** Do not call this while another consumer (a `readline` interface, or the Ink
 * TUI) owns stdin — they will conflict over the same stream.
 *
 * @param prompt - Label printed before the user types, e.g., `"Enter password: "`.
 * @returns The password as entered by the user. Empty string is valid.
 * @throws {Error} On a non-TTY stdin that has run out of input.
 *
 * @example
 * ```ts
 * const password = await readMaskedPassword("Enter your password: ");
 * console.log(`Password length: ${password.length}`);
 * ```
 */
export const readMaskedPassword = (prompt: string): Promise<string> => {
  const stdout = process.stdout;
  const stdin = process.stdin;
  stdout.write(prompt);

  // Non-TTY (piped input, CI): read the line directly, since raw mode is
  // unavailable. Input is not masked in this mode — there is no terminal to
  // mask it on — but it is also not echoed back by this process.
  if (!stdin.isTTY) {
    return readLineFromPipedStdin();
  }

  // TTY: enable raw mode to intercept keystrokes individually and mask them with bullets.
  return new Promise((resolve) => {
    // Raw mode disables line buffering so we receive each keystroke immediately.
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let pwd = "";
    const onData = (chunk: string | Buffer) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // A single chunk may contain multiple characters (e.g., from paste or rapid typing).
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        // Enter, Return, or Ctrl+D (ASCII 4) signals end of input.
        if (ch === "\n" || ch === "\r" || code === 4) {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          resolve(pwd);
          return;
        }
        // Backspace (ASCII 127) or Delete (\b): remove last character from both screen and buffer.
        if (code === 127 || ch === "\b") {
          if (pwd.length > 0) {
            pwd = pwd.slice(0, -1);
            stdout.write("\b \b"); // Backspace, space, backspace to erase bullet
          }
          continue;
        }
        // All other characters are treated as password input and masked on screen.
        pwd += ch;
        stdout.write("•");
      }
    };
    stdin.on("data", onData);
  });
};
