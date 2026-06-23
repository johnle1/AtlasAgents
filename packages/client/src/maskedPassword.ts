import * as readline from "node:readline";

/**
 * @async
 * <Summary>
 * What it does:
 *   Reads one password line from stdin. On a real terminal, each key shows as • instead of the real character.
 *
 * How it does it (step by step):
 *   1. Prints `prompt` to the terminal.
 *   2. Not a TTY (e.g. piped input): use readline once to read a line. Echo is normal, not masked. Line is trimEnd().
 *   3. TTY: turn on raw keyboard mode so we see keys one-by-one.
 *   4. TTY: for each key — Enter or Ctrl+D finishes; Backspace removes the last • and character; other keys append
 *      to the password and print •.
 *   5. TTY: turn raw mode off, stop listening, print a newline, return the password (can be empty).
 *
 * Parameters:
 *   @param prompt - Label printed before the user types (e.g. "Enter password: ").
 *
 * Returns:
 *   @returns The password. Empty string is allowed.
 *
 * Note:
 *   Do not use while the main readline prompt owns stdin; the two fight over the same stream.
 * </Summary>
 */
export const readMaskedPassword = (prompt: string): Promise<string> => {
  const stdout = process.stdout;
  const stdin = process.stdin;
  // Prompt is written here; readline path uses question("") so we do not duplicate the label.
  stdout.write(prompt);

  // Pipes / CI: one normal readline line (password may be visible).
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      // Empty prompt string — the visible question was already written above.
      rl.question("", (line) => {
        rl.close();
        resolve(line.trimEnd());
      });
    });
  }

  // Interactive terminal: raw mode + per-key • echo.
  return new Promise((resolve) => {
    // Raw: Node delivers stdin as small chunks instead of cooked line editing.
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let pwd = "";
    const onData = (chunk: string | Buffer) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // One chunk can contain several keypresses (e.g. paste or fast typing).
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        // Enter, Return, or Ctrl+D — done.
        if (ch === "\n" || ch === "\r" || code === 4) {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          resolve(pwd);
          return;
        }
        // Backspace / Delete — rub out last character on screen and in pwd.
        if (code === 127 || ch === "\b") {
          if (pwd.length > 0) {
            pwd = pwd.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        // Any other byte is treated as password input and masked on screen.
        pwd += ch;
        stdout.write("•");
      }
    };
    stdin.on("data", onData);
  });
};
