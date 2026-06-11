import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { SKILLS_DIR } from "./config.js";
import type { Connection, SkillPayload } from "./connection/index.js";

/**
 * <Summary>
 * What it does:
 *   Bundled default skill markdown files shipped with the CLI package.
 *
 * Used by:
 *   - installDefaultSkills — copies these into ~/.agent-cli/skills/ on first run.
 *
 * Produced by:
 *   - None (static assets in packages/client/default-skills/).
 * </Summary>
 */
const DEFAULT_SKILLS_PACKAGE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "default-skills",
);

/**
 * <Summary>
 * What it does:
 *   On first run only, seeds ~/.agent-cli/skills/ from packaged defaults when
 *   that directory did not exist yet.
 *
 * How it does it (step by step):
 *   1. Returns immediately if SKILLS_DIR already exists (any prior run or user state).
 *   2. Creates SKILLS_DIR with recursive mkdir.
 *   3. If the packaged default-skills directory is missing, returns without error.
 *   4. Reads packaged directory entries, filters to .md files.
 *   5. Copies each file into SKILLS_DIR with the same basename.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - fs — mkdirSync, existsSync, readdirSync, copyFileSync.
 *
 * Dependants:
 *   - ensureSkillsDir — invokes this before guaranteeing the directory exists.
 *   - SkillManager constructor — triggers first-run seed via ensureSkillsDir.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Ensures the local skills directory exists after optional default seeding.
 *
 * How it does it (step by step):
 *   1. Calls installDefaultSkills so first run copies defaults when appropriate.
 *   2. Calls mkdirSync on SKILLS_DIR with recursive: true as a final guarantee.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - installDefaultSkills — may populate SKILLS_DIR when new.
 *   - fs.mkdirSync — creates SKILLS_DIR if still missing.
 *
 * Dependants:
 *   - listSkills, addSkill, readAllSkills, readSkill — call before touching files.
 * </Summary>
 */
export const ensureSkillsDir = (): void => {
  installDefaultSkills();
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
};

/**
 * <Summary>
 * What it does:
 *   Returns an array of skill file basenames (without .md extension) from
 *   the ~/.agent-cli/skills/ directory.
 *
 * How it does it (step by step):
 *   1. Ensures the SKILLS_DIR exists (and default seed on first run).
 *   2. Reads all filenames from SKILLS_DIR.
 *   3. Filters to only .md files.
 *   4. Strips the .md extension from each filename.
 *   5. Returns the array of basenames.
 *   6. Returns empty array on any error (e.g. permission denied).
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {string[]} — Array of skill names e.g. ["coding", "research"].
 *
 * Dependencies:
 *   - ensureSkillsDir — ensures SKILLS_DIR exists before reading.
 *   - fs.readdirSync — reads directory listing.
 *
 * Dependants:
 *   - CommandHandler.handleSkills (list subcommand) — calls this to display skills.
 *   - readAllSkills — calls this to get the list before reading file contents.
 *   - SkillManager.list — delegates here.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Creates a new skill markdown file in ~/.agent-cli/skills/ and opens
 *   it in the user's default text editor.
 *
 * How it does it (step by step):
 *   1. Ensures SKILLS_DIR exists.
 *   2. Constructs the full path to <name>.md.
 *   3. Checks if the file already exists — throws if it does.
 *   4. Writes a minimal markdown template with the skill name as h1.
 *   5. Looks up $EDITOR or $VISUAL env var, falls back to "vi".
 *   6. Spawns the editor process with the file path.
 *   7. Waits for the editor to close (uses inherit stdio so it's interactive).
 *   8. Ignores editor exit errors (file is still created).
 *
 * Parameters:
 *   @param {string} name — Skill basename without extension.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * @throws {Error} — When a skill with the same name already exists.
 *
 * Dependencies:
 *   - ensureSkillsDir — ensures SKILLS_DIR exists before writing.
 *   - fs.existsSync — checks for existing file.
 *   - fs.writeFileSync — writes the initial template.
 *   - execSync — spawns the editor process.
 *
 * Dependants:
 *   - CommandHandler.handleSkills (add subcommand) — calls this to create a skill.
 *   - SkillManager.create — delegates here.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Reads the UTF-8 contents of one skill file by basename (no .md suffix).
 *
 * How it does it (step by step):
 *   1. Ensures SKILLS_DIR exists.
 *   2. Resolves path.join(SKILLS_DIR, `${name}.md`).
 *   3. Throws if the file is missing.
 *   4. Returns fs.readFileSync as utf-8 string.
 *
 * Parameters:
 *   @param {string} name — Skill basename without extension.
 *
 * Returns:
 *   @returns {string} — Full markdown file contents.
 *
 * @throws {Error} — When the skill file does not exist.
 *
 * Dependencies:
 *   - ensureSkillsDir — ensures directory exists.
 *   - fs.existsSync, fs.readFileSync — file access.
 *
 * Dependants:
 *   - SkillManager.read — delegates here.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Reads all skill markdown files from ~/.agent-cli/skills/ and returns
 *   them as an array of { name, content } objects ready to sync to the server.
 *
 * How it does it (step by step):
 *   1. Ensures SKILLS_DIR exists.
 *   2. Calls listSkills to get all skill basenames.
 *   3. For each name, reads the corresponding .md file as UTF-8.
 *   4. Returns an array of SkillPayload objects.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {SkillPayload[]} — Array of { name, content } objects.
 *
 * Dependencies:
 *   - ensureSkillsDir — ensures SKILLS_DIR exists.
 *   - listSkills — gets the list of skill names.
 *   - fs.readFileSync — reads file contents.
 *
 * Dependants:
 *   - CommandHandler.handleSkills (sync subcommand) — calls this before syncing to server.
 *   - SkillManager.readAll and SkillManager.sync — delegate here.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Manages local ~/.agent-cli/skills/ markdown files and syncs them to the
 *   server through Connection.
 *
 * How it fits in the system:
 *   Wraps listSkills, addSkill, readSkill, readAllSkills with the Part 5 API
 *   and runs default-skill installation on construction so first-run seeding
 *   happens before the REPL handles slash commands.
 *
 * Dependencies:
 *   - Connection — sync uploads skill payloads.
 *   - installDefaultSkills — invoked from constructor for first-run behaviour.
 *
 * Dependants:
 *   - index.ts main — constructs one instance per session.
 *   - CommandHandler — optional reference for skills commands.
 * </Summary>
 */
export class SkillManager {
  /**
   * <Summary>
   * What it does:
   *   Stores the Connection reference and runs first-run default skill seeding.
   *
   * How it does it (step by step):
   *   1. Retains conn for sync().
   *   2. Calls installDefaultSkills so ~/.agent-cli/skills/ is populated from
   *      packaged defaults only when that directory did not already exist.
   *
   * Parameters:
   *   @param {Connection} conn — Live RSocket connection used by sync().
   *
   * Returns:
   *   void — constructor side effects only.
   *
   * Dependencies:
   *   - installDefaultSkills — optional copy from default-skills/.
   *
   * Dependants:
   *   - index.ts main — constructs SkillManager after Connection.connect.
   * </Summary>
   */
  constructor(private readonly conn: Connection) {
    installDefaultSkills();
  }

  /**
   * <Summary>
   * What it does:
   *   Lists skill basenames (no .md) under ~/.agent-cli/skills/.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {string[]} — Skill names.
   *
   * Dependencies:
   *   - listSkills — reads directory.
   *
   * Dependants:
   *   - CommandHandler.handleSkills — when skills manager is wired.
   * </Summary>
   */
  list = (): string[] => listSkills();

  /**
   * <Summary>
   * What it does:
   *   Creates a new empty skill file and opens it in $EDITOR.
   *
   * Parameters:
   *   @param {string} name — Basename without .md.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   - addSkill — file + editor.
   *
   * Dependants:
   *   - CommandHandler.handleSkills — add subcommand.
   * </Summary>
   */
  create = (name: string): void => {
    addSkill(name);
  };

  /**
   * <Summary>
   * What it does:
   *   Returns the UTF-8 body of one skill file.
   *
   * Parameters:
   *   @param {string} name — Basename without .md.
   *
   * Returns:
   *   @returns {string} — File contents.
   *
   * Dependencies:
   *   - readSkill — filesystem read.
   *
   * Dependants:
   *   - None (available for future commands).
   * </Summary>
   */
  read = (name: string): string => readSkill(name);

  /**
   * <Summary>
   * What it does:
   *   Loads every .md skill as name/content pairs.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {SkillPayload[]} — All skills.
   *
   * Dependencies:
   *   - readAllSkills — bulk read.
   *
   * Dependants:
   *   - SkillManager.sync — uses same data path.
   * </Summary>
   */
  readAll = (): SkillPayload[] => readAllSkills();

  /**
   * @async
   * <Summary>
   * What it does:
   *   Reads all local skills and uploads them via Connection.syncSkills.
   *
   * How it does it (step by step):
   *   1. Calls readAllSkills for the current payloads.
   *   2. Awaits this.conn.syncSkills with that array.
   *   3. Returns how many skills were sent.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<number>} — Count of skills synced.
   *
   * Dependencies:
   *   - readAllSkills — local aggregation.
   *   - Connection.syncSkills — RSocket command.
   *
   * Dependants:
   *   - CommandHandler.handleSkills — sync subcommand.
   * </Summary>
   */
  sync = async (): Promise<number> => {
    const skills = readAllSkills();
    await this.conn.syncSkills(skills);
    return skills.length;
  };

  /**
   * Syncs local skills to the server once (e.g. after connect).
   */
  autoSync = async (): Promise<number> => this.sync();
}
