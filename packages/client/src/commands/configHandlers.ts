/**
 * Configuration slash commands: `/agent`, `/set`, and `/config`.
 *
 * @remarks
 * Connection-affecting `/set` keys (`password`, `server`, `port`) call
 * {@link Connection.reload} after persisting so the live RSocket session picks
 * up the new endpoint. Model selection is delegated to {@link handleSetModel}.
 */

import { loadConfig, updateConfig } from "../config.js";
import type { PromptPort } from "../ui/promptPort.js";
import type { Connection } from "../connection/index.js";
import { getTheme } from "../theme/themeManager.js";
import { printError, printSuccess } from "../renderer.js";
import { parsePort } from "./utils.js";
import { logger } from "../utils/logger.js";

/**
 * Handles `/agent cap [n|::max]` — concurrency limit for parallel agents.
 *
 * @remarks
 * - No value → print current `agentCap`
 * - `::max` → `Number.MAX_SAFE_INTEGER` (no practical cap)
 * - Otherwise parse an integer ≥ 1 (floored)
 *
 * Unknown subs (anything other than `cap` or empty) print usage and return.
 *
 * @param sub - Token after `/agent` (`"cap"` or empty).
 * @param arg - Cap value when `sub === "cap"`.
 *
 * @example
 * ```ts
 * handleAgent("cap", "");       // show current
 * handleAgent("cap", "4");      // set to 4
 * handleAgent("cap", "::max");  // unlimited
 * ```
 */
export const handleAgent = (sub: string, arg: string): void => {
  if (sub !== "cap" && sub.length > 0) {
    printError("Usage: /agent cap [n]  ( default is 3; ::max for no cap)");
    return;
  }

  const capArgument = sub === "cap" ? arg.trim() : "";

  if (capArgument.length === 0) {
    const currentConfig = loadConfig();
    printSuccess(`Agent cap: ${currentConfig.agentCap} (use ::max for no cap)`);
    return;
  }

  if (capArgument === "::max") {
    updateConfig({ agentCap: Number.MAX_SAFE_INTEGER });
    printSuccess("Agent cap set to unlimited (::max)");
    return;
  }

  const parsedCapValue = parseInt(capArgument, 10);
  if (!Number.isFinite(parsedCapValue)) {
    printError("Agent cap must be a number.");
    return;
  }

  // At least one agent; floor so "3.9" becomes 3 rather than truncating oddly later.
  const finalCapValue = Math.max(1, Math.floor(parsedCapValue));
  updateConfig({ agentCap: finalCapValue });
  printSuccess(`Agent cap set to ${finalCapValue}`);
};

/**
 * Handles `/set` for password, server, port, and advisor/agent model role.
 *
 * @remarks
 * Inline args are preferred; when omitted the user is prompted. Password input
 * uses masked prompts when available. After password/server/port updates,
 * {@link Connection.reload} reconnects if transport settings changed.
 *
 * @param sub - Setting name: `password` | `server` | `port` | `advisor` | `agent`.
 * @param arg - Optional inline value.
 * @param connection - Connection to reload after transport settings change.
 * @param prompts - Interactive question / masked password helpers.
 * @param handleSetModel - Callback for `/set advisor|agent` model picking.
 *
 * @example
 * ```ts
 * await handleSet("port", "7000", connection, prompts, setModel);
 * await handleSet("advisor", "", connection, prompts, setModel);
 * ```
 */
export const handleSet = async (
  sub: string,
  arg: string,
  connection: Connection,
  prompts: PromptPort,
  handleSetModel: (role: "advisor" | "agent") => Promise<void>,
): Promise<void> => {
  if (!sub) {
    printError(
      "Usage: /set password [value] | /set server [host] | /set port [n] | /set advisor | /set agent",
    );
    return;
  }

  switch (sub) {
    case "password": {
      let passwordValue = arg.trim().length > 0 ? arg.trim() : "";

      if (!passwordValue) {
        // Readline masking is limited — warn so users know the value may echo.
        logger.info(
          `${getTheme().textSecondary}  Password echo is visible in the REPL (masked input needs no readline).${getTheme().reset}`,
        );
        passwordValue = (
          await prompts.question("  New password: ", { masked: true })
        ).trimEnd();
      }

      const updatedConfig = updateConfig({ password: passwordValue });
      await connection.reload(updatedConfig);
      printSuccess("Password updated.");
      break;
    }

    case "server": {
      let serverHost = arg.trim();

      if (!serverHost) {
        const userInput = await prompts.question(
          "  Enter server address (default localhost): ",
        );
        serverHost = userInput.trim() || "localhost";
      }

      const updatedConfig = updateConfig({ server: serverHost });
      await connection.reload(updatedConfig);
      printSuccess(`Server set to ${serverHost}`);
      break;
    }

    case "port": {
      let portNumber: number | null = null;
      const inlinePortArgument = arg.trim();

      if (inlinePortArgument.length > 0) {
        portNumber = parsePort(inlinePortArgument);
      } else {
        const userInput = await prompts.question(
          "  Enter port (default 7000): ",
        );
        const trimmedInput = userInput.trim();
        // Empty prompt answer → conventional LoopyCode default port.
        portNumber = trimmedInput.length === 0 ? 7000 : parsePort(trimmedInput);
      }

      if (portNumber === null) {
        printError("Port must be an integer between 1 and 65535.");
        return;
      }

      const updatedConfig = updateConfig({ port: portNumber });
      await connection.reload(updatedConfig);
      printSuccess(`Port set to ${portNumber}`);
      break;
    }

    case "advisor":
    case "agent": {
      await handleSetModel(sub);
      break;
    }

    default: {
      printError(
        "Unknown /set subcommand. Use: password, server, port, advisor, or agent.",
      );
      break;
    }
  }
};

/**
 * Handles `/config` — prints the on-disk configuration table.
 *
 * @remarks
 * Dynamically imports `printConfig` to avoid a circular dependency with the
 * renderer module graph at load time.
 *
 * @example
 * ```ts
 * await handleConfig();
 * ```
 */
export const handleConfig = async (): Promise<void> => {
  const currentConfig = loadConfig();
  // Dynamic import breaks a renderer ↔ commands cycle at module evaluation time.
  const { printConfig } = await import("../renderer.js");
  printConfig(currentConfig);
};
