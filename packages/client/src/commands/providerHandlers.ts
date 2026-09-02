/**
 * Provider management slash commands under `/providers`.
 *
 * @remarks
 * Providers are non-Ollama, OpenAI-compatible model backends (LM Studio,
 * llama.cpp's server, a hosted API, ...) registered on the server. `"ollama"`
 * always exists and is not managed here. There is no `/providers add` — add
 * one by editing `providers` in the server's `user-data/config.json`
 * directly (see the README's Providers section). Subcommands are one-shot
 * commands over RSocket.
 */

import type { Connection } from "../connection/index.js";
import { formatErrorMessage } from "./utils.js";
import { printProviders, printError, printSuccess } from "../renderer.js";

/**
 * Routes `/providers list | remove`.
 *
 * @param subcommand - Operation name after `/providers`.
 * @param argument - Remaining raw argument text.
 * @param connection - Live RSocket connection.
 *
 * @example
 * ```ts
 * await handleProviders("list", "", connection);
 * await handleProviders("remove", "lmstudio", connection);
 * ```
 */
export const handleProviders = async (
  subcommand: string,
  argument: string,
  connection: Connection,
): Promise<void> => {
  switch (subcommand) {
    case "list": {
      try {
        const response = await connection.sendCommand<{
          providers: Record<string, { baseUrl?: string }>;
          agentProvider: string;
          subagentProvider: string;
        }>("providers.list", {});
        printProviders(
          response.providers,
          response.agentProvider,
          response.subagentProvider,
        );
      } catch (error) {
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    case "remove": {
      const name = argument.trim();
      if (!name) {
        printError("Usage: /providers remove <name>");
        return;
      }

      try {
        await connection.sendCommand("providers.remove", { name });
        printSuccess(`Provider '${name}' removed.`);
      } catch (error) {
        printError(`Failed: ${formatErrorMessage(error)}`);
      }
      break;
    }
    default:
      printError("Usage: /providers list | remove <name>");
  }
};
