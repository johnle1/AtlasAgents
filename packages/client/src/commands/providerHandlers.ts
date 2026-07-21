/**
 * Provider management slash commands under `/providers`.
 *
 * @remarks
 * Providers are non-Ollama, OpenAI-compatible model backends (vLLM on a GPU
 * box, AWS Trainium, Google TPU, ...) registered on the server. `"ollama"`
 * always exists and is not managed here. Subcommands are one-shot commands
 * over RSocket.
 */

import type { Connection } from "../connection/index.js";
import { formatErrorMessage } from "./utils.js";
import { printProviders, printError, printSuccess } from "../renderer.js";

/** Parsed `/providers add <name> --url <baseUrl> [--key <apiKey>]` arguments. */
type ParsedAddArgs = { name: string; baseUrl: string; apiKey?: string };

/**
 * Parses the free-text argument for `/providers add`.
 *
 * @param argument - Everything after `/providers add`, e.g.
 *   `"vllm-gpu --url http://localhost:8000/v1 --key secret"`.
 * @returns Parsed fields, or null when the name or `--url` is missing.
 */
const parseAddArgs = (argument: string): ParsedAddArgs | null => {
  const tokens = argument.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const name = tokens[0];
  let baseUrl = "";
  let apiKey: string | undefined;

  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === "--url" && tokens[i + 1]) {
      baseUrl = tokens[i + 1];
      i++;
    } else if (tokens[i] === "--key" && tokens[i + 1]) {
      apiKey = tokens[i + 1];
      i++;
    }
  }

  if (!baseUrl) return null;
  return { name, baseUrl, apiKey };
};

/**
 * Routes `/providers list | add | remove`.
 *
 * @param subcommand - Operation name after `/providers`.
 * @param argument - Remaining raw argument text.
 * @param connection - Live RSocket connection.
 *
 * @example
 * ```ts
 * await handleProviders("list", "", connection);
 * await handleProviders("add", "vllm-gpu --url http://localhost:8000/v1", connection);
 * await handleProviders("remove", "vllm-gpu", connection);
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
    case "add": {
      const parsed = parseAddArgs(argument);
      if (!parsed) {
        printError(
          "Usage: /providers add <name> --url <baseUrl> [--key <apiKey>]",
        );
        return;
      }

      try {
        await connection.sendCommand("providers.add", parsed);
        printSuccess(`Provider '${parsed.name}' added (${parsed.baseUrl}).`);
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
      printError(
        "Usage: /providers list | add <name> --url <baseUrl> [--key <apiKey>] | remove <name>",
      );
  }
};
