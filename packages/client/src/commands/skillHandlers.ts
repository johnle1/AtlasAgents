/**
 * Custom skill slash commands under `/skills`.
 *
 * @remarks
 * Skills are local markdown instruction packs. Prefer an injected
 * {@link SkillManager} when present; otherwise fall back to module-level
 * helpers and {@link Connection.syncSkills}.
 */

import {
  listSkills,
  addSkill,
  readAllSkills,
  type SkillManager,
} from "../skills.js";
import { printSkills, printError, printSuccess } from "../renderer.js";
import type { Connection } from "../connection/index.js";
import { formatErrorMessage } from "./utils.js";

/**
 * Routes `/skills list | add <name> | sync`.
 *
 * @remarks
 * - `list` — prints local skill names
 * - `add` — creates a skill file (and typically opens an editor via create/add)
 * - `sync` — uploads skill payloads to the server for advisor/agent use
 *
 * @param sub - Subcommand after `/skills`.
 * @param arg - Skill name for `add`.
 * @param skills - Optional SkillManager; when set, `sync`/`list`/`create` use it.
 * @param conn - Connection used by the no-manager sync fallback.
 *
 * @example
 * ```ts
 * await handleSkills("list", "", skills, connection);
 * await handleSkills("add", "testing", skills, connection);
 * await handleSkills("sync", "", skills, connection);
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
      if (skills) {
        try {
          const syncedCount = await skills.sync();
          if (syncedCount === 0) {
            printError("No skills to sync. Use /skills add <name> first.");
            return;
          }
          printSuccess(`Synced ${syncedCount} skill(s) to server.`);
        } catch (err) {
          printError(`Sync failed: ${formatErrorMessage(err)}`);
        }
        break;
      }

      // No SkillManager — read files from disk and push via Connection.
      const skillList = readAllSkills();
      if (skillList.length === 0) {
        printError("No skills to sync. Use /skills add <name> first.");
        return;
      }
      try {
        await conn.syncSkills(skillList);
        printSuccess(`Synced ${skillList.length} skill(s) to server.`);
      } catch (err) {
        printError(`Sync failed: ${formatErrorMessage(err)}`);
      }
      break;
    }
    default:
      printError("Usage: /skills list | /skills add <name> | /skills sync");
      break;
  }
};
