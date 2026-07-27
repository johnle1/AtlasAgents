import { printError } from "../renderer.js";
import {
  enqueueTokenSaveOperation,
  getTokenSaveClient,
  hasTokenSaveIndex,
  disconnectTokenSaveClient,
} from "./tokenSaveClient.js";

export type McpCallResult = {
  isError: boolean;
  data?: unknown;
  errorMessage?: string;
};

const formatToolContent = (content: unknown): unknown => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content;
  }
  return content
    .map((block) => {
      if (
        typeof block === "object" &&
        block !== null &&
        "text" in block &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        const text = (block as { text: string }).text;
        return text;
      }
      return JSON.stringify(block);
    })
    .join("\n");
};

const formatToolContentAsString = (content: unknown): string => {
  const formatted = formatToolContent(content);
  if (typeof formatted === "string") {
    return formatted;
  }
  if (formatted === undefined) {
    return "";
  }
  try {
    return JSON.stringify(formatted);
  } catch {
    return String(formatted);
  }
};

export const ensureInitialized = async (
  workspaceRoot: string,
): Promise<boolean> => hasTokenSaveIndex(workspaceRoot);

const invokeTokenSaveTool = async (
  workspaceRoot: string,
  tool: string,
  args: unknown,
): Promise<McpCallResult> => {
  try {
    const client = await getTokenSaveClient(workspaceRoot);
    const result = await client.callTool({
      name: tool,
      arguments: (args ?? {}) as Record<string, unknown>,
    });

    if (result.isError) {
      return {
        isError: true,
        errorMessage: formatToolContentAsString(result.content),
        data: result.content,
      };
    }

    return {
      isError: false,
      data: formatToolContent(result.content),
    };
  } catch (error) {
    await disconnectTokenSaveClient();
    return {
      isError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};

export const callTokenSaveTool = async (
  workspaceRoot: string,
  tool: string,
  args: unknown,
): Promise<McpCallResult> => {
  const ready = await ensureInitialized(workspaceRoot);
  if (!ready) {
    printError(
      "TokenSave not initialized for this workspace. Run /tokensave init to enable faster code search.",
    );
    return {
      isError: true,
      errorMessage: "TokenSave not initialized. Run /tokensave init.",
    };
  }

  return enqueueTokenSaveOperation(() =>
    invokeTokenSaveTool(workspaceRoot, tool, args),
  );
};
