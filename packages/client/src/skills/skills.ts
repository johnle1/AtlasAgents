import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { SKILLS_DIR } from "../config/index.js";
import type { Connection, SkillPayload } from "../connection/index.js";

/**
 * Rejects skill names that would escape `SKILLS_DIR`.
 *
 * @remarks
 * Skill names become `path.join(SKILLS_DIR, \`${name}.md\`)` with no other
 * validation, so an unchecked name containing `..`, a path separator, or an
 * absolute path would read or write outside the skills directory.
 *
 * @param name - Skill basename to validate, as given to `addSkill`/`readSkill`.
 * @throws When `name` is empty, contains a path separator, contains a `..`
 *   segment, or is itself an absolute path.
 */
export const assertSafeSkillName = (name: string): void => {
  if (name.trim().length === 0) {
    throw new Error("Skill name must not be empty.");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error(`Skill name must not contain a path separator: "${name}"`);
  }
  if (name === "." || name === ".." || name.split(/[/\\]/).includes("..")) {
    throw new Error(`Skill name must not contain "..": "${name}"`);
  }
  if (path.isAbsolute(name)) {
    throw new Error(`Skill name must not be an absolute path: "${name}"`);
  }
};

/**
 * Path to the bundled default skill markdown files.
 *
 * @remarks
 * This directory contains default skill templates shipped with the CLI package.
 * On first run, these are copied to ~/.atlasagents/skills/ to provide users with
 * starting examples.
 */
const DEFAULT_SKILLS_PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "default-skills",
);

/**
 * Seeds the local skills directory with bundled defaults on first run.
 *
 * @remarks
 * Only runs if ~/.atlasagents/skills/ does not exist yet. Copies all .md files
 * from the packaged default-skills directory to the user's skills directory.
 * If the default-skills directory is missing (e.g., in development), returns
 * silently without error.
 *
 * @example
 * ```ts
 * installDefaultSkills(); // Only runs on first run
 * ```
 */
export const installDefaultSkills = (): void => {
  if (fs.existsSync(SKILLS_DIR)) {
    return;
  }
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  if (!fs.existsSync(DEFAULT_SKILLS_PACKAGE_DIR)) {
    return;
  }
  const files = fs.readdirSync(DEFAULT_SKILLS_PACKAGE_DIR);
  for (const name of files) {
    if (!name.endsWith(".md")) continue;
    const from = path.join(DEFAULT_SKILLS_PACKAGE_DIR, name);
    const to = path.join(SKILLS_DIR, name);
    fs.copyFileSync(from, to);
  }
};

/**
 * Ensures the local skills directory exists.
 *
 * @remarks
 * Calls installDefaultSkills to seed defaults on first run, then guarantees
 * the directory exists with recursive mkdir. Safe to call multiple times.
 *
 * @example
 * ```ts
 * ensureSkillsDir(); // Safe to call before any skill operations
 * ```
 */
export const ensureSkillsDir = (): void => {
  installDefaultSkills();
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
};

/**
 * Returns an array of skill file basenames from the local skills directory.
 *
 * @remarks
 * Reads ~/.atlasagents/skills/ and returns skill names without the .md extension.
 * Returns an empty array on any error (e.g., permission denied) to fail gracefully.
 *
 * @returns Array of skill names e.g., `["coding", "research"]`.
 *
 * @example
 * ```ts
 * const skills = listSkills();
 * console.log(skills); // ["coding", "research"]
 * ```
 */
export const listSkills = (): string[] => {
  ensureSkillsDir();
  try {
    return fs
      .readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
};

/**
 * Creates a new skill markdown file and opens it in the user's default editor.
 *
 * @remarks
 * Creates a minimal markdown template with the skill name as h1. Uses
 * $EDITOR or $VISUAL environment variables, falling back to "vi". The file
 * is created even if the editor fails to launch.
 *
 * @param name - Skill basename without extension.
 * @throws When a skill with the same name already exists.
 *
 * @example
 * ```ts
 * addSkill("my-skill"); // Opens editor with ~/agent-cli/skills/my-skill.md
 * ```
 */
export const addSkill = (name: string): void => {
  assertSafeSkillName(name);
  ensureSkillsDir();
  const filePath = path.join(SKILLS_DIR, `${name}.md`);

  if (fs.existsSync(filePath)) {
    throw new Error(`Skill "${name}" already exists at ${filePath}`);
  }

  fs.writeFileSync(
    filePath,
    `# ${name}\n\nDescribe this skill here.\n`,
    "utf-8",
  );

  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  // Split so multi-word editors like "code -w" still resolve to a binary
  // plus flags. $EDITOR/$VISUAL are trusted env vars; filePath is the only
  // untrusted part, and execFileSync passes it as a single argv entry with
  // no shell to re-parse it, unlike the previous execSync template string.
  const [editorBin, ...editorArgs] = editor.split(/\s+/).filter(Boolean);
  try {
    if (editorBin) {
      execFileSync(editorBin, [...editorArgs, filePath], { stdio: "inherit" });
    }
  } catch {
    // Editor exited non-zero or wasn't found — file is still created
  }
};

/**
 * Reads the UTF-8 contents of a skill file by basename.
 *
 * @param name - Skill basename without extension.
 * @returns Full markdown file contents.
 * @throws When the skill file does not exist.
 *
 * @example
 * ```ts
 * const content = readSkill("coding");
 * console.log(content); // "# coding\n\nDescribe this skill here.\n"
 * ```
 */
export const readSkill = (name: string): string => {
  assertSafeSkillName(name);
  ensureSkillsDir();
  const filePath = path.join(SKILLS_DIR, `${name}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Skill "${name}" not found at ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf-8");
};

/**
 * Reads all skill markdown files and returns them as skill payloads.
 *
 * @remarks
 * Loads all .md files from ~/.atlasagents/skills/ and returns them as
 * { name, content } objects ready to sync to the server.
 *
 * @returns Array of { name, content } objects.
 *
 * @example
 * ```ts
 * const skills = readAllSkills();
 * console.log(skills); // [{ name: "coding", content: "..." }, ...]
 * ```
 */
export const readAllSkills = (): SkillPayload[] => {
  ensureSkillsDir();
  const names = listSkills();
  return names.map((name) => ({
    name,
    content: fs.readFileSync(path.join(SKILLS_DIR, `${name}.md`), "utf-8"),
  }));
};

/**
 * Reads all skill markdown files from an arbitrary directory.
 *
 * @remarks
 * Used by `/skills sync <path>` to sync skills from a custom directory
 * instead of the default ~/.atlasagents/skills/ location. Unlike readAllSkills,
 * this does not seed defaults or fall back on error — an invalid path throws.
 *
 * @param dirPath - Absolute path to a directory containing skill .md files.
 * @returns Array of { name, content } objects.
 * @throws When dirPath does not exist or is not a directory.
 *
 * @example
 * ```ts
 * const skills = readSkillsFromDir("/Users/john/my-skills");
 * console.log(skills); // [{ name: "coding", content: "..." }, ...]
 * ```
 */
export const readSkillsFromDir = (dirPath: string): SkillPayload[] => {
  const stats = fs.statSync(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
  return fs
    .readdirSync(dirPath)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({
      name: name.replace(/\.md$/, ""),
      content: fs.readFileSync(path.join(dirPath, name), "utf-8"),
    }));
};

/**
 * Manages local skill markdown files and syncs them to the server.
 *
 * @remarks
 * Wraps the skill file operations (list, add, read, readAll) with the
 * Connection API for server synchronization. Runs default-skill installation
 * on construction so first-run seeding happens before the REPL handles
 * slash commands.
 *
 * @example
 * ```ts
 * const manager = new SkillManager(connection);
 * await manager.sync(); // Uploads all local skills to server
 * ```
 */
export class SkillManager {
  /**
   * Creates a SkillManager with the given connection.
   *
   * @remarks
   * Stores the connection for sync operations and runs first-run default
   * skill seeding to populate ~/.atlasagents/skills/ if it doesn't exist.
   *
   * @param conn - Live RSocket connection used by sync.
   */
  constructor(private readonly conn: Connection) {
    installDefaultSkills();
  }

  /**
   * Lists skill basenames (no .md) under ~/.atlasagents/skills/.
   *
   * @returns Skill names.
   */
  list = (): string[] => listSkills();

  /**
   * Creates a new empty skill file and opens it in $EDITOR.
   *
   * @param name - Basename without .md.
   */
  create = (name: string): void => {
    addSkill(name);
  };

  /**
   * Returns the UTF-8 body of one skill file.
   *
   * @param name - Basename without .md.
   * @returns File contents.
   */
  read = (name: string): string => readSkill(name);

  /**
   * Loads every .md skill as name/content pairs.
   *
   * @returns All skills.
   */
  readAll = (): SkillPayload[] => readAllSkills();

  /**
   * Reads local skills and uploads them to the server.
   *
   * @remarks
   * Reads from ~/.atlasagents/skills/ by default, or from `dirPath` when
   * given (via readSkillsFromDir), then uploads them via Connection.syncSkills.
   * Only ever runs when the user explicitly triggers it (e.g. `/skills sync`) —
   * there is no automatic sync on connect.
   *
   * @param dirPath - Optional directory to sync skills from instead of the
   *   default ~/.atlasagents/skills/ location.
   * @returns Count of skills synced.
   *
   * @example
   * ```ts
   * await manager.sync(); // Uploads ~/.atlasagents/skills/
   * await manager.sync("/Users/john/my-skills"); // Uploads from a custom path
   * ```
   */
  sync = async (dirPath?: string): Promise<number> => {
    const skills = dirPath ? readSkillsFromDir(dirPath) : readAllSkills();
    await this.conn.syncSkills(skills);
    return skills.length;
  };
}
