import * as readline from "node:readline";

/**
 * Reads one password line from stdin, masking each keystroke with a bullet point on interactive terminals.
 *
 * @remarks
 * This function provides secure password input by masking typed characters with `•` on TTY terminals.
 * In non-TTY environments (e.g., piped input or CI), it falls back to normal readline behavior
 * without masking since raw mode is unavailable.
 *
 * **Behavior:**
 * - TTY: Enables raw keyboard mode to intercept individual keystrokes. Each printable character
 *   appends to the password and prints `•`. Backspace removes the last character and bullet.
 *   Enter or Ctrl+D submits the password.
 * - Non-TTY: Uses standard readline with normal echo (password may be visible). The line is
 *   trimmed of trailing whitespace before returning.
 *
 * **Important:** Do not call this while another readline interface owns stdin — they will
 * conflict over the same stream.
 *
 * @param prompt - Label printed before the user types, e.g., `"Enter password: "`.
 * @returns The password as entered by the user. Empty string is valid.
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
  // Write prompt once here; the non-TTY path uses question("") to avoid duplicating it.
  stdout.write(prompt);

  // Non-TTY (piped input, CI): fall back to normal readline since raw mode is unavailable.
  // Password will be visible in this mode, but it's the only option without a terminal.
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      // Empty prompt string because the visible label was already written above.
      rl.question("", (line) => {
        rl.close();
        resolve(line.trimEnd());
      });
    });
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
