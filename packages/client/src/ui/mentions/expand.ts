/**
 * `@path` mention expansion for the prompt.
 *
 * @remarks
 * Tokens like `@README.md` or `@src/` are replaced with an inlined file
 * or directory listing before the line is sent to the agent. `resolvePath`
 * is injected so unit tests never touch the filesystem. Email-like
 * `user@host` tokens are left alone. Secret-ish names (`.env`, keys) are
 * refused with an inline error rather than inlined.
 *
 * Missing paths that look like files (`@missing.ts`) become an inline
 * error; bare `@alice`-style tokens that do not resolve are left literal.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Files larger than this are skipped (not dumped into the prompt). */
export const MAX_MENTION_BYTES = 256_000;

/**
 * Result of stating a mention path.
 */
export type MentionStat = {
  kind: "file" | "dir" | "missing";
  /** Basename used for secret-file checks. */
  name: string;
  /** Byte size when `kind` is `"file"`. */
  size?: number;
};

/**
 * Injected filesystem for {@link expandMentions}.
 */
export type MentionResolver = {
  stat: (mentionPath: string) => Promise<MentionStat>;
  readText: (mentionPath: string) => Promise<string>;
  listDir: (mentionPath: string) => Promise<string[]>;
};

/**
 * Minimal file-proxy surface the production resolver needs.
 */
export type FileProxyLike = {
  resolveAbsolute: (relativePath: string) => string;
  getCwd: () => string;
  listDirectoryEntries: (
    dirPath: string,
  ) => Promise<Array<{ name: string; isDirectory: boolean }>>;
};

const SECRET_BASENAMES = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  "credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];

/**
 * True when `basename` looks like a secret file we must not dump into a prompt.
 *
 * @param basename - File name only (no directories).
 */
export const isSecretMentionName = (basename: string): boolean => {
  const lower = basename.toLowerCase();
  if (SECRET_BASENAMES.has(lower)) return true;
  if (lower.startsWith(".env.")) return true;
  return SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};

const isPathLike = (token: string): boolean =>
  /[./\\]/.test(token) || token.startsWith(".");

/**
 * Finds `@path` tokens. Skips `user@host` (the `@` is mid-token).
 *
 * @param text - Raw prompt.
 * @returns Start/end offsets and the path (quotes stripped).
 */
export const findMentionSpans = (
  text: string,
): Array<{ start: number; end: number; mentionPath: string }> => {
  const spans: Array<{ start: number; end: number; mentionPath: string }> = [];
  const pattern = /(^|[\s])@(?:"([^"]+)"|([^\s@]+))/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    const prefix = match[1] ?? "";
    const quoted = match[2];
    const bare = match[3];
    const mentionPath = quoted ?? bare ?? "";
    const atIndex = match.index + prefix.length;
    spans.push({
      start: atIndex,
      end: atIndex + match[0].length - prefix.length,
      mentionPath,
    });
    match = pattern.exec(text);
  }
  return spans;
};

const formatFileBlock = (mentionPath: string, content: string): string =>
  `\n# File: ${mentionPath}\n\`\`\`\n${content.replace(/\n$/, "")}\n\`\`\`\n`;

const formatDirBlock = (mentionPath: string, listing: string[]): string => {
  const lines = listing.map((name) => `- ${name}`).join("\n");
  return `\n# Directory: ${mentionPath}\n${lines}\n`;
};

const formatError = (mentionPath: string, reason: string): string =>
  `[Could not read @${mentionPath}: ${reason}]`;

const expandOne = async (
  mentionPath: string,
  resolver: MentionResolver,
): Promise<string | null> => {
  let stat: MentionStat;
  try {
    stat = await resolver.stat(mentionPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return formatError(mentionPath, message);
  }

  if (stat.kind === "missing") {
    if (!isPathLike(mentionPath)) {
      return null;
    }
    return formatError(mentionPath, "not found");
  }

  if (isSecretMentionName(stat.name)) {
    return `[Refused to read @${mentionPath}: looks like a secret file]`;
  }

  if (stat.kind === "dir") {
    try {
      const listing = await resolver.listDir(mentionPath);
      return formatDirBlock(mentionPath, listing);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return formatError(mentionPath, message);
    }
  }

  if ((stat.size ?? 0) > MAX_MENTION_BYTES) {
    return `[Skipped @${mentionPath}: file too large]`;
  }

  try {
    const content = await resolver.readText(mentionPath);
    if (content.includes("\0")) {
      return `[Skipped @${mentionPath}: binary or non-text]`;
    }
    return formatFileBlock(mentionPath, content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return formatError(mentionPath, message);
  }
};

/**
 * Replaces `@path` mentions with inlined file/dir blocks.
 *
 * @param text - Raw submitted prompt.
 * @param resolver - Injected stat/read/list (fixture map in tests).
 * @returns Expanded text. Unresolved non-path tokens are left as typed.
 *
 * @example
 * ```ts
 * const { text } = await expandMentions("see @README.md", resolver);
 * // text includes "# File: README.md" and the file body
 * ```
 */
export const expandMentions = async (
  text: string,
  resolver: MentionResolver,
): Promise<{ text: string }> => {
  const spans = findMentionSpans(text);
  if (spans.length === 0) {
    return { text };
  }

  const replacements = await Promise.all(
    spans.map((span) => expandOne(span.mentionPath, resolver)),
  );

  let output = "";
  let cursor = 0;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    const replacement = replacements[index];
    output += text.slice(cursor, span.start);
    output += replacement ?? text.slice(span.start, span.end);
    cursor = span.end;
  }
  output += text.slice(cursor);
  return { text: output };
};

/**
 * Completes the last `@token` against workspace names.
 *
 * @param input - Current prompt.
 * @param names - File/dir names in the cwd (or search set).
 * @returns Input with the token completed, or `null` if nothing matches.
 */
export const completeMention = (
  input: string,
  names: string[],
): string | null => {
  const match = /(?:^|[\s])@([^\s@]*)$/.exec(input);
  if (!match) return null;
  const prefix = match[1] ?? "";
  const hit = names.find((name) =>
    name.toLowerCase().startsWith(prefix.toLowerCase()),
  );
  if (!hit) return null;
  const atIndex = input.lastIndexOf("@");
  if (atIndex < 0) return null;
  return `${input.slice(0, atIndex)}@${hit}`;
};

/**
 * Builds a {@link MentionResolver} on top of {@link LocalFileProxy}.
 *
 * @param proxy - Workspace-sandboxed file proxy.
 * @returns Resolver used by {@link expandMentions} on submit.
 */
export const resolverFromFileProxy = (proxy: FileProxyLike): MentionResolver => ({
  stat: async (mentionPath) => {
    try {
      const absolutePath = proxy.resolveAbsolute(mentionPath);
      const stats = await fs.stat(absolutePath);
      if (stats.isDirectory()) {
        return { kind: "dir", name: path.basename(absolutePath) };
      }
      return {
        kind: "file",
        name: path.basename(absolutePath),
        size: stats.size,
      };
    } catch {
      return {
        kind: "missing",
        name: path.basename(mentionPath),
      };
    }
  },
  readText: async (mentionPath) => {
    const absolutePath = proxy.resolveAbsolute(mentionPath);
    return fs.readFile(absolutePath, "utf8");
  },
  listDir: async (mentionPath) => {
    const absolutePath = proxy.resolveAbsolute(mentionPath);
    const entries = await proxy.listDirectoryEntries(absolutePath);
    return entries.map((entry) =>
      entry.isDirectory ? `${entry.name}/` : entry.name,
    );
  },
});
