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
 *   @returns Array of skill names e.g. ["coding", "research"].
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
 *   @param name - Skill basename without extension.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * @throws {Error} — When a skill with the same name already exists.
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
 *   @param name - Skill basename without extension.
 *
 * Returns:
 *   @returns Full markdown file contents.
 *
 * @throws {Error} — When the skill file does not exist.
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
 *   @returns Array of { name, content } objects.
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
   *   @param conn - Live RSocket connection used by sync().
   *
   * Returns:
   *   void — constructor side effects only.
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
   *   @returns Skill names.
   * </Summary>
   */
  list = (): string[] => listSkills();

  /**
   * <Summary>
   * What it does:
   *   Creates a new empty skill file and opens it in $EDITOR.
   *
   * Parameters:
   *   @param name - Basename without .md.
   *
   * Returns:
   *   void — called for side effects only.
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
   *   @param name - Basename without .md.
   *
   * Returns:
   *   @returns File contents.
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
   *   @returns All skills.
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
   *   @returns Count of skills synced.
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
