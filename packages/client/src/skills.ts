import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { SKILLS_DIR, ensureDirs } from './config.js'
import type { SkillPayload } from './connection.js'

/**
 * <Summary>
 * What it does:
 *   Returns an array of skill file basenames (without .md extension) from
 *   the ~/.agent-cli/skills/ directory.
 *
 * How it does it (step by step):
 *   1. Ensures the SKILLS_DIR exists.
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
 *   - ensureDirs — ensures SKILLS_DIR exists before reading.
 *   - fs.readdirSync — reads directory listing.
 *
 * Dependants:
 *   - CommandHandler.handleSkills (list subcommand) — calls this to display skills.
 *   - readAllSkills — calls this to get the list before reading file contents.
 * </Summary>
 */
export const listSkills = (): string[] => {
  ensureDirs()
  try {
    return fs
      .readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
  } catch {
    return []
  }
}

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
 *   - ensureDirs — ensures SKILLS_DIR exists before writing.
 *   - fs.existsSync — checks for existing file.
 *   - fs.writeFileSync — writes the initial template.
 *   - execSync — spawns the editor process.
 *
 * Dependants:
 *   - CommandHandler.handleSkills (add subcommand) — calls this to create a skill.
 * </Summary>
 */
export const addSkill = (name: string): void => {
  ensureDirs()
  const filePath = path.join(SKILLS_DIR, `${name}.md`)

  if (fs.existsSync(filePath)) {
    throw new Error(`Skill "${name}" already exists at ${filePath}`)
  }

  fs.writeFileSync(filePath, `# ${name}\n\nDescribe this skill here.\n`, 'utf-8')

  const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi'
  try {
    execSync(`${editor} "${filePath}"`, { stdio: 'inherit' })
  } catch {
    // Editor exited non-zero or wasn't found — file is still created
  }
}

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
 *   - ensureDirs — ensures SKILLS_DIR exists.
 *   - listSkills — gets the list of skill names.
 *   - fs.readFileSync — reads file contents.
 *
 * Dependants:
 *   - CommandHandler.handleSkills (sync subcommand) — calls this before syncing to server.
 * </Summary>
 */
export const readAllSkills = (): SkillPayload[] => {
  ensureDirs()
  const names = listSkills()
  return names.map((name) => ({
    name,
    content: fs.readFileSync(path.join(SKILLS_DIR, `${name}.md`), 'utf-8'),
  }))
}
