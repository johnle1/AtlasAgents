/**
 * TokenSave CLI slash commands and bootstrap helpers (`/tokensave`).
 *
 * @remarks
 * TokenSave is an optional local indexer (`tokensave` on `PATH`) used for
 * faster workspace search. These helpers check install/index state, run
 * `tokensave init` with approval, sync curated MCP tools to the server, and
 * print status via the MCP bridge.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Connection } from "../connection/index.js";
import type { LocalFileProxy } from "../localFileProxy.js";
import { printError, printLine, printSuccess } from "../renderer.js";
import { requestApprovalWithFeedback } from "../ui/approvalFlow.js";
import { callTokenSaveTool } from "../mcp/mcpBridge.js";
import {
  enqueueTokenSaveOperation,
  getTokenSaveClient,
  hasTokenSaveIndex,
  isTokenSaveOnPath,
  listCuratedTools,
} from "../mcp/tokenSaveClient.js";
import { formatErrorMessage } from "./utils.js";

const execFileAsync = promisify(execFile);

/**
 * Runs `tokensave init` in the given workspace.
 *
 * @remarks
 * Isolated as its own function (rather than an inline `execFileAsync` call in
 * {@link handleTokenSave}) so the actual process spawn is a single, swappable
 * seam — e.g. for a future test double — instead of buried inside a large
 * switch-case handler. Uses `execFile` (not a shell) so `init` is not
 * re-parsed by `/bin/sh`.
 *
 * @param workspaceRoot - Absolute path to run `tokensave init` in.
 */
const runTokenSaveInit = (workspaceRoot: string): Promise<unknown> =>
  execFileAsync("tokensave", ["init"], { cwd: workspaceRoot });

/**
 * Pretty-prints MCP / TokenSave tool payloads for the terminal.
 *
 * @param data - String or JSON-serializable value from the tool result.
 * @returns Display string (unchanged if already a string).
 */
const formatMcpData = (data: unknown): string => {
  if (typeof data === "string") {
    return data;
  }
  return JSON.stringify(data, null, 2);
};

/**
 * Discovers curated TokenSave tools and syncs them to the server.
 *
 * @remarks
 * No-ops (returns `0`) when `tokensave` is missing from `PATH` or the workspace
 * has no `.tokensave` index yet. Otherwise enqueues work on the TokenSave
 * client and sends `mcp.tools.sync` with the curated tool list.
 *
 * @param conn - Live RSocket connection.
 * @param workspaceRoot - Absolute workspace path used for the TokenSave client.
 * @returns Number of tools synced, or `0` when skipped / empty.
 *
 * @example
 * ```ts
 * const n = await syncTokenSaveTools(connection, "/proj");
 * ```
 */
export const syncTokenSaveTools = async (
  conn: Connection,
  workspaceRoot: string,
): Promise<number> => {
  if (!(await isTokenSaveOnPath())) {
    return 0;
  }
  if (!(await hasTokenSaveIndex(workspaceRoot))) {
    return 0;
  }

  return enqueueTokenSaveOperation(async () => {
    const client = await getTokenSaveClient(workspaceRoot);
    const tools = await listCuratedTools(client);
    if (tools.length === 0) {
      return 0;
    }

    await conn.sendCommand("mcp.tools.sync", { tools });
    return tools.length;
  });
};

/**
 * Prints a one-line tip to run `/tokensave init` when indexing would help.
 *
 * @remarks
 * Silent when TokenSave is not installed or an index already exists — avoids
 * nagging on every startup in those cases.
 *
 * @param workspaceRoot - Absolute workspace path to inspect.
 */
export const printTokenSaveInitTip = async (
  workspaceRoot: string,
): Promise<void> => {
  if (!(await isTokenSaveOnPath())) {
    return;
  }
  if (await hasTokenSaveIndex(workspaceRoot)) {
    return;
  }
  printLine(
    "  Tip: run /tokensave init for faster code search this session.",
  );
};

/**
 * Routes `/tokensave init | status`.
 *
 * @remarks
 * - `init` — requires `tokensave` on PATH, user approval, then `tokensave init`
 *   in the workspace and an optional tool sync
 * - `status` — calls the `tokensave_status` MCP tool and prints its data
 *
 * Workspace root comes from {@link LocalFileProxy.getWorkspaceRoot} when the
 * proxy is available, otherwise `process.cwd()`.
 *
 * @param sub - Subcommand after `/tokensave`.
 * @param _arg - Unused (reserved for future flags).
 * @param conn - Live RSocket connection for tool sync after init.
 * @param fileProxy - Optional proxy for resolving the workspace root.
 *
 * @example
 * ```ts
 * await handleTokenSave("init", "", connection, fileProxy);
 * await handleTokenSave("status", "", connection, fileProxy);
 * ```
 */
export const handleTokenSave = async (
  sub: string,
  _arg: string,
  conn: Connection,
  fileProxy?: LocalFileProxy,
): Promise<void> => {
  const workspaceRoot = fileProxy?.getWorkspaceRoot() ?? process.cwd();

  switch (sub) {
    case "init": {
      if (!(await isTokenSaveOnPath())) {
        printError(
          "TokenSave is not installed. Install it with: cargo install tokensave",
        );
        return;
      }

      if (await hasTokenSaveIndex(workspaceRoot)) {
        printSuccess("TokenSave is already initialized for this workspace.");
        return;
      }

      const { approved } = await requestApprovalWithFeedback(
        {
          type: "keepUndo",
          contextLabel:
            "Initialize TokenSave index (.tokensave/ folder will be created)",
        },
        "What should change?",
      );

      if (!approved) {
        printLine("TokenSave init cancelled.");
        return;
      }

      try {
        await runTokenSaveInit(workspaceRoot);
        printSuccess("TokenSave initialized. Syncing tools to server...");
        const synced = await syncTokenSaveTools(conn, workspaceRoot);
        if (synced > 0) {
          printSuccess(`Synced ${synced} TokenSave tool(s) to server.`);
        }
      } catch (err) {
        printError(`TokenSave init failed: ${formatErrorMessage(err)}`);
      }
      break;
    }
    case "status": {
      try {
        const result = await callTokenSaveTool(
          workspaceRoot,
          "tokensave_status",
          {},
        );
        if (result.isError) {
          printError(result.errorMessage ?? "TokenSave status failed");
          return;
        }
        printLine(formatMcpData(result.data));
      } catch (err) {
        printError(`TokenSave status failed: ${formatErrorMessage(err)}`);
      }
      break;
    }
    default:
      printError("Usage: /tokensave init | /tokensave status");
  }
};
