import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);

export const ALLOWED_TOKENSAVE_TOOLS = new Set([
  "tokensave_context",
  "tokensave_search",
  "tokensave_status",
  "tokensave_callers",
  "tokensave_callees",
  "tokensave_impact",
]);

export type McpToolDef = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

let sharedClient: Client | null = null;
let sharedWorkspaceRoot: string | null = null;
let operationQueue: Promise<unknown> = Promise.resolve();

/** Serialize MCP stdio operations — the transport is not safe for concurrent use. */
export const enqueueTokenSaveOperation = <T>(
  operation: () => Promise<T>,
): Promise<T> => {
  const run = operationQueue.then(operation, operation);
  operationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const closeSharedClientIfCurrent = async (client: Client): Promise<void> => {
  await client.close();
  if (sharedClient === client) {
    sharedClient = null;
    sharedWorkspaceRoot = null;
  }
};

const connectTokenSaveClient = async (
  workspaceRoot: string,
): Promise<Client> => {
  if (sharedClient && sharedWorkspaceRoot === workspaceRoot) {
    try {
      await sharedClient.listTools({});
      return sharedClient;
    } catch {
      await closeSharedClientIfCurrent(sharedClient);
    }
  }

  if (sharedClient) {
    await closeSharedClientIfCurrent(sharedClient);
  }

  const transport = new StdioClientTransport({
    command: "tokensave",
    args: ["serve"],
    cwd: workspaceRoot,
  });
  const client = new Client({ name: "atlasagents", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    sharedClient = null;
    sharedWorkspaceRoot = null;
    throw error;
  }

  sharedClient = client;
  sharedWorkspaceRoot = workspaceRoot;
  return client;
};

export const hasTokenSaveIndex = async (
  workspaceRoot: string,
): Promise<boolean> => {
  try {
    await fs.access(path.join(workspaceRoot, ".tokensave"));
    return true;
  } catch {
    return false;
  }
};

export const isTokenSaveOnPath = async (): Promise<boolean> => {
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(locator, ["tokensave"]);
    return true;
  } catch {
    return false;
  }
};

/** Must only be called from within `enqueueTokenSaveOperation`. */
export const getTokenSaveClient = async (
  workspaceRoot: string,
): Promise<Client> => connectTokenSaveClient(workspaceRoot);

/** Closes the shared client without resetting the operation queue. Must only be called from within `enqueueTokenSaveOperation`. */
export const disconnectTokenSaveClient = async (): Promise<void> => {
  if (sharedClient) {
    await closeSharedClientIfCurrent(sharedClient);
  }
};

export const listCuratedTools = async (
  client: Client,
): Promise<McpToolDef[]> => {
  const all: McpToolDef[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    for (const tool of page.tools) {
      if (!ALLOWED_TOKENSAVE_TOOLS.has(tool.name)) {
        continue;
      }
      all.push({
        name: tool.name,
        description: tool.description,
        inputSchema: (tool.inputSchema ?? {
          type: "object",
          properties: {},
        }) as Record<string, unknown>,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);

  return all;
};

/** @internal Reset singleton between tests. */
export const resetTokenSaveClientForTests = async (): Promise<void> => {
  await disconnectTokenSaveClient();
  operationQueue = Promise.resolve();
};
