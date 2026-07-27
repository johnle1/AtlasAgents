/**
 * Custom skill slash commands under `/skills`.
 *
 * @remarks
 * Skills are local markdown instruction packs. Prefer an injected
 * {@link SkillManager} when present; otherwise fall back to module-level
 * helpers and {@link Connection.syncSkills}.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listSkills,
  addSkill,
  readAllSkills,
  readSkillsFromDir,
  type SkillManager,
} from "../skills/skills.js";
import { printSkills, printError, printSuccess } from "../renderer.js";
import type { Connection } from "../connection/index.js";
import { formatErrorMessage } from "./utils.js";

/**
 * Resolves a user-supplied `/skills sync` path argument to an absolute path.
 *
 * @remarks
 * Expands a leading `~` to the home directory (shell-style), then resolves
 * to absolute. Mirrors the path-handling convention used by `/workspace set`.
 *
 * @param rawPath - Trimmed, non-empty path argument from the user.
 * @returns Absolute, resolved directory path.
 */
const resolveSyncPath = (rawPath: string): string => {
  const expandedPath = rawPath.startsWith("~")
    ? path.join(os.homedir(), rawPath.slice(1))
    : rawPath;
  return path.resolve(expandedPath);
};

/**
 * Prints the outcome of a `/skills sync` after it has already run.
 *
 * @param syncedCount - Number of skills actually synced (0 means nothing to send).
 */
const printSyncResult = (syncedCount: number): void => {
  if (syncedCount === 0) {
    printError("No skills to sync. Use /skills add <name> first.");
    return;
  }
  printSuccess(`Synced ${syncedCount} skill(s) to server.`);
};

/**
 * Routes `/skills list | add <name> | sync`.
 *
 * @remarks
 * - `list` — prints local skill names
 * - `add` — creates a skill file (and typically opens an editor via create/add)
 * - `sync` — uploads skill payloads to the server for agent/subagent use
 *
 * @param sub - Subcommand after `/skills`.
 * @param arg - Skill name for `add`; optional source directory for `sync`.
 * @param skills - Optional SkillManager; when set, `sync`/`list`/`create` use it.
 * @param conn - Connection used by the no-manager sync fallback.
 *
 * @example
 * ```ts
 * await handleSkills("list", "", skills, connection);
 * await handleSkills("add", "testing", skills, connection);
 * await handleSkills("sync", "", skills, connection); // default ~/.agent-cli/skills/
 * await handleSkills("sync", "/Users/john/my-skills", skills, connection);
 * ```
 */
export const handleSkills = async (
  sub: string,
  arg: string,
  skills: SkillManager | undefined,
  conn: Connection,
): Promise<void> => {
  switch (sub) {
    case "list":
      printSkills(skills?.list() ?? listSkills());
      break;
    case "add": {
      const skillName = arg.trim();
      if (!skillName) {
        printError("Usage: /skills add <name>");
        return;
      }
      try {
        if (skills) {
          skills.create(skillName);
        } else {
          addSkill(skillName);
        }
        printSuccess(`Skill "${skillName}" created.`);
      } catch (err) {
        printError(formatErrorMessage(err));
      }
      break;
    }
    case "sync": {
      // Optional path argument: sync from a custom directory instead of
      // the default ~/.agent-cli/skills/. Empty arg keeps default behavior.
      const rawPath = arg.trim();
      let dirPath: string | undefined;
      if (rawPath) {
        dirPath = resolveSyncPath(rawPath);
        try {
          const stats = fs.statSync(dirPath);
          if (!stats.isDirectory()) {
            printError("Path is not a directory.");
            return;
          }
        } catch {
          printError(`Directory not found: ${dirPath}`);
          return;
        }
      }

      if (skills) {
        try {
          const syncedCount = await skills.sync(dirPath);
          printSyncResult(syncedCount);
        } catch (err) {
          printError(`Sync failed: ${formatErrorMessage(err)}`);
        }
        break;
      }

      // No SkillManager — read files from disk and push via Connection.
      const skillList = dirPath ? readSkillsFromDir(dirPath) : readAllSkills();
      if (skillList.length === 0) {
        printError("No skills to sync. Use /skills add <name> first.");
        return;
      }
      try {
        await conn.syncSkills(skillList);
        printSyncResult(skillList.length);
      } catch (err) {
        printError(`Sync failed: ${formatErrorMessage(err)}`);
      }
      break;
    }
    default:
      printError(
        "Usage: /skills list | /skills add <name> | /skills sync [path]",
      );
      break;
  }
};
