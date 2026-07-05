import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { SKILLS_DIR } from "./config.js";
import type { Connection, SkillPayload } from "./connection/index.js";

/**
 * Path to the bundled default skill markdown files.
 *
 * @remarks
 * This directory contains default skill templates shipped with the CLI package.
 * On first run, these are copied to ~/.agent-cli/skills/ to provide users with
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
 * Only runs if ~/.agent-cli/skills/ does not exist yet. Copies all .md files
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
 * Reads ~/.agent-cli/skills/ and returns skill names without the .md extension.
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
  try {
    execSync(`${editor} "${filePath}"`, { stdio: "inherit" });
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
 * Loads all .md files from ~/.agent-cli/skills/ and returns them as
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
   * skill seeding to populate ~/.agent-cli/skills/ if it doesn't exist.
   *
   * @param conn - Live RSocket connection used by sync.
   */
  constructor(private readonly conn: Connection) {
    installDefaultSkills();
  }

  /**
   * Lists skill basenames (no .md) under ~/.agent-cli/skills/.
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
   * Reads all local skills and uploads them to the server.
   *
   * @remarks
   * Calls readAllSkills to get current payloads, then uploads them via
   * Connection.syncSkills. Returns the count of skills synced.
   *
   * @returns Count of skills synced.
   */
  sync = async (): Promise<number> => {
    const skills = readAllSkills();
    await this.conn.syncSkills(skills);
    return skills.length;
  };

  /**
   * Syncs local skills to the server once (e.g., after connect).
   *
   * @returns Count of skills synced.
   */
  autoSync = async (): Promise<number> => this.sync();
}
