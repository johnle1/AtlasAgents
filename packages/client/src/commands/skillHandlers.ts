/**
 * Skill-related command handlers.
 *
 * This module handles commands for managing custom skills:
 * - /skills list, add, sync
 */

import {
  listSkills,
  addSkill,
  readAllSkills,
  type SkillManager,
} from "../skills.js";
import { printSkills, printError, printSuccess } from "../renderer.js";
import type { Connection } from "../connection/index.js";

/**
 * <Summary>
 * What it does:
 *   Handles "/skills list", "/skills add <name>", and "/skills sync"
 *   by routing to the appropriate skill operation.
 *
 * How it does it (step by step):
 *   1. Routes based on subcommand (list, add, sync).
 *   2. For list: calls listSkills and prints via renderer.printSkills.
 *   3. For add: validates name, calls addSkill to create file and open editor.
 *   4. For sync: calls readAllSkills, then Connection.syncSkills to upload.
 *   5. Prints success or error messages for each operation.
 *
 * Parameters:
 *   @param {string} sub — Subcommand: "list", "add", or "sync".
 *   @param {string} arg — Argument for add subcommand (skill name).
 *   @param {SkillManager | undefined} skills — Optional SkillManager instance.
 *   @param {Connection} conn — RSocket connection for syncing skills.
 *
 * Returns:
 *   @returns {Promise<void>} — called for side effects only.
 *
 * Dependencies:
 *   - SkillManager or listSkills, addSkill, readAllSkills — local skill files and optional manager.
 *   - Connection.syncSkills — uploads skill payloads when not using SkillManager.sync.
 *   - renderer.printSkills, printError, printSuccess — display output.
 *
 * Dependants:
 *   - CommandHandler.handle — calls this for /skills commands.
 * </Summary>
 */
export const handleSkills = async (
  sub: string,
  arg: string,
  skills: SkillManager | undefined,
  conn: Connection,
): Promise<void> => {
  switch (sub) {
    case "list":
      // List available skills using SkillManager or module function
      printSkills(skills?.list() ?? listSkills());
      break;
    case "add": {
      const skillName = arg.trim();
      if (!skillName) {
        printError("Usage: /skills add <name>");
        return;
      }
      try {
        // Create skill using SkillManager or module function
        if (skills) {
          skills.create(skillName);
        } else {
          addSkill(skillName);
        }
        printSuccess(`Skill "${skillName}" created.`);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
      }
      break;
    }
    case "sync": {
      // Use SkillManager if available
      if (skills) {
        try {
          const syncedCount = await skills.sync();
          if (syncedCount === 0) {
            printError("No skills to sync. Use /skills add <name> first.");
            return;
          }
          printSuccess(`Synced ${syncedCount} skill(s) to server.`);
        } catch (err) {
          printError(
            `Sync failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        break;
      }
      // Fallback to module functions if no SkillManager
      const skillList = readAllSkills();
      if (skillList.length === 0) {
        printError("No skills to sync. Use /skills add <name> first.");
        return;
      }
      try {
        await conn.syncSkills(skillList);
        printSuccess(`Synced ${skillList.length} skill(s) to server.`);
      } catch (err) {
        printError(`Sync failed: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }
    default:
      printError("Usage: /skills list | /skills add <name> | /skills sync");
      break;
  }
};
