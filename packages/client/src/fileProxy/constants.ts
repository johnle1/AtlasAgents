/**
 * Static policy sets for traversal skips, quiet routes, and shell classification.
 *
 * @remarks
 * Consumed by directory listing, {@link LocalFileProxy.handle} spinner logic, and
 * {@link classifyCommand}. Edit carefully — classification is intentionally
 * heuristic, not a full shell security sandbox.
 */

/**
 * Directory basenames skipped while walking or listing the workspace.
 *
 * @remarks
 * Avoids drowning listings in dependency/build noise (`node_modules`, `.git`,
 * `dist`, `.next`). Matching is by **entry name only**, not full path.
 */
export const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
]);

/**
 * Proxy routes that complete so quickly that a working spinner would flicker.
 *
 * @remarks
 * {@link LocalFileProxy.handle} skips `startWorking` / teardown animation for
 * these metadata routes (`file.get_cwd`, `command.classify`).
 */
export const QUIET_PROXY_ROUTES = new Set(["file.get_cwd", "command.classify"]);

/**
 * Base executables treated as read-only → classification `"safe"`.
 *
 * @remarks
 * Only the **first** whitespace token is matched (e.g. `ls`, `cat`). Pipelines
 * or wrappers around dangerous tools are **not** fully modeled — unknown / mixed
 * forms fall through to `"cautious"` or `"dangerous"` via token scans.
 */
export const SAFE_BASE_COMMANDS = new Set([
  "ls",
  "find",
  "cat",
  "head",
  "tail",
  "grep",
  "pwd",
  "echo",
  "wc",
]);

/**
 * `git <subcommand>` values treated as read-only → `"safe"`.
 *
 * @remarks
 * Requires base command `git` plus a second token in this set (`status`, `log`,
 * `diff`). Mutating git ops are left to the dangerous-token / cautious paths.
 */
export const SAFE_GIT_SUBCOMMANDS = new Set(["status", "log", "diff"]);

/**
 * Command tokens that force classification `"dangerous"`.
 *
 * @remarks
 * Matched as whole whitespace-separated tokens after lowercasing (e.g. `rm`,
 * `-rf`, `--force`). Presence of any token here fails closed to requiring
 * explicit user approval with a danger warning in the CLI.
 *
 * Includes `find`'s action primaries (`-exec`, `-delete`, `-fprintf`, …).
 * Those run commands or write/destroy files using only spaces — no shell
 * metacharacter — so {@link SHELL_METACHARACTER_PATTERN} cannot catch them
 * and `find` being in {@link SAFE_BASE_COMMANDS} would otherwise auto-approve
 * e.g. `find . -maxdepth 0 -exec sh payload {} +`.
 */
export const DANGEROUS_TOKENS = new Set([
  "rm",
  "rmdir",
  "-rf",
  "-f",
  "--force",
  "--hard",
  "drop",
  "truncate",
  "dd",
  "mkfs",
  "reset",
  "chmod",
  "-fdx",
  // find primaries that execute commands
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  // find primaries that destroy or write files
  "-delete",
  "-fprintf",
  "-fprint",
  "-fprint0",
  "-fls",
  // Windows cmd.exe equivalents of the above (del/erase ~ rm, rd ~ rmdir,
  // format/diskpart destroy whole volumes, reg can rewrite arbitrary
  // registry state). The classifier's SAFE_BASE_COMMANDS/find-primary lists
  // are POSIX-shaped, but this deny-list applies regardless of platform.
  "del",
  "erase",
  "rd",
  "format",
  "diskpart",
  "reg",
]);

/**
 * `find` primaries that only match or print — safe to auto-approve.
 *
 * @remarks
 * `find` is the one entry in {@link SAFE_BASE_COMMANDS} whose own flags can
 * execute code, so it gets an allow-list rather than relying on the
 * {@link DANGEROUS_TOKENS} deny-list alone. Any `-flag` not listed here fails
 * closed to `"cautious"`, so a primary nobody thought of (or a new one added
 * by a future `find` release) cannot silently inherit `"safe"`.
 *
 * `-printf`/`-ls` are included (they write to stdout); their `-fprintf`/`-fls`
 * counterparts write to arbitrary files and are in {@link DANGEROUS_TOKENS}.
 */
export const SAFE_FIND_PRIMARIES = new Set([
  // matching
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-lname",
  "-ilname",
  "-regex",
  "-iregex",
  "-type",
  "-xtype",
  "-size",
  "-empty",
  "-perm",
  "-user",
  "-group",
  "-uid",
  "-gid",
  "-nouser",
  "-nogroup",
  "-links",
  "-inum",
  "-samefile",
  "-newer",
  "-newermt",
  "-anewer",
  "-cnewer",
  "-atime",
  "-ctime",
  "-mtime",
  "-amin",
  "-cmin",
  "-mmin",
  "-used",
  // traversal control
  "-maxdepth",
  "-mindepth",
  "-depth",
  "-prune",
  "-quit",
  "-follow",
  "-mount",
  "-xdev",
  "-noleaf",
  "-ignore_readdir_race",
  "-noignore_readdir_race",
  // operators
  "-a",
  "-and",
  "-o",
  "-or",
  "-not",
  // stdout-only output
  "-print",
  "-print0",
  "-printf",
  "-ls",
]);

/**
 * Shell metacharacters that can chain, redirect, or substitute a second,
 * unvetted command onto an otherwise allow-listed base command (e.g.
 * `echo x && rm -rf /`, `cat f | sh`, `echo x > ~/.bashrc`, `` `whoami` ``,
 * `$(curl …)`, `type %USERPROFILE%\.ssh\id_rsa`). Any command containing
 * one of these must never be classified `"safe"` purely from its first
 * token.
 *
 * @remarks
 * Deliberately does not distinguish quoted occurrences from real ones
 * (e.g. `grep "a;b" file.txt` also matches) — consistent with this
 * module's fail-closed-to-`"cautious"` philosophy rather than parsing
 * quoting/escaping.
 *
 * The `%VAR%` alternative is cmd.exe's variable-expansion syntax — matched
 * as a balanced `%name%` pair (not a bare `%`) so an ordinary percent sign
 * in output (`echo 50% done`) doesn't get flagged; `^`, cmd.exe's escape
 * character, is deliberately **not** included here — it's also the regex
 * start-anchor, and `grep '^foo'` is common enough that classifying it
 * `"cautious"` would be a worse everyday trade-off than the risk it closes.
 */
export const SHELL_METACHARACTER_PATTERN =
  /[;&|`<>\n]|\$\(|%[A-Za-z_][A-Za-z0-9_]*%/;

/**
 * Argument shapes that point outside the workspace the agent is scoped to.
 *
 * @remarks
 * `command.run` sets only `cwd` — unlike the `file.*` routes, it has no path
 * confinement — so an allow-listed reader (`cat`, `grep`, `find`, …) given an
 * absolute or traversing path reads anywhere the user can, returns the
 * contents to the server, and (because `"safe"` commands print only a timing
 * line) shows the user nothing. `cat /Users/you/.ssh/id_rsa` must therefore
 * require approval rather than auto-run.
 *
 * Matches a POSIX absolute path (`/etc/passwd`), a home-relative path
 * (`~/.aws`), a `..` traversal segment (`/` or `\` delimited, so it also
 * catches `..\`), a Windows drive-absolute path (`C:\Users\...`), a UNC
 * path (`\\server\share`), an env-var reference used as a path prefix
 * (`$HOME/.ssh`, `${HOME}/.ssh` — see below), or any of those tucked into a
 * flag value (`--file=/etc/passwd`, `--file=C:\Users\...`). Workspace-relative
 * arguments (`src/a.ts`, `.`, `*.ts`) do not match and stay eligible for
 * `"safe"`.
 *
 * The env-var branch (`\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[/\\]`) only matches a
 * `$VAR`/`${VAR}` reference **immediately followed by a path separator** —
 * `cat $HOME/.ssh/id_rsa` and `cat ${HOME}/.ssh/id_rsa` are the same
 * "reads outside the workspace" shape as `cat ~/.ssh/id_rsa`, just spelled
 * with a shell variable instead of `~`. A bare reference with nothing after
 * it (`echo $HOME`, `echo $PATH`) only ever prints a value — it doesn't read
 * a file — so it deliberately does not match and stays `"safe"`.
 */
export const ESCAPING_PATH_PATTERN =
  /^[/~]|^\.\.(?:[/\\]|$)|[/\\]\.\.(?:[/\\]|$)|=[/~]|^[A-Za-z]:[/\\]|^\\\\|=[A-Za-z]:[/\\]|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[/\\]/;
