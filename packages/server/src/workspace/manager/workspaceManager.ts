/**
 * Manages workspace operations by relaying file system commands (read, write, list, search) from the server to a connected CLI client via RSocket bridge, with optional operation logging. How it works (high level): 1. Stores a requesterId that identifies the connected client. 2. Each operation validates that a client is bound, then sends the operation to that client. 3. Supports optional context recording that logs operations for experience/learning purposes. Key Concepts: - requesterId: String that identifies which client session to route operations to. - ClientBridge: RSocket transport layer that handles client communication. - WorkspaceRecorderContext: Optional logging context with taskId for operation tracking. - WorkspaceError: Custom error type for workspace-specific failures (NO_ROOT, OUTSIDE_ROOT, NOT_FOUND).
 *
 * @remarks
 * - Orchestrator — uses setRoot, readFile, writeFile for task execution. - Advisor — uses searchFiles and listStructure for codebase exploration. - Agent — uses workspace operations for file manipulation during tasks.
 * : WorkspaceManager — Proxies file operations to the connected CLI client.
 */

import type { ClientBridge } from "../../transport/clientBridge.js";
import { buildEditAnchorHint } from "../execution/editFileHelpers.js";
import { NotFoundError, ValidationError } from "../../errors/index.js";
import {
  type WorkspaceRecorderContext,
  WorkspaceError,
} from "./workspaceTypes.js";

/**
 * Maintains connection state to a single client and routes all file operations through that client's RSocket bridge, with optional operation logging. How it works (instance lifecycle): 1. Create instance with ClientBridge passed to constructor. 2. Wait for client to connect (requesterId set via bindRequester). 3. Call workspace methods (readFile, writeFile, etc.) which relay to that client. 4. Operations validate requesterId is set, then send via bridge. 5. Optional context parameter enables operation logging.
 *
 * @remarks
 * - Container assembly — creates and configures WorkspaceManager. - Orchestration layer (Advisor, Agent, Orchestrator) — calls workspace methods.
 * : WorkspaceManager — Proxies file operations to connected CLI client.
 */
export class WorkspaceManager {
  private requesterId: string | null = null;
  private state: "ACTIVE" | "DISPOSED" = "ACTIVE";

  /**
 * Stores a reference to the ClientBridge for later use in routing operations. How it works (step by step): 1. Receives ClientBridge instance (parameter property). 2. Stores bridge reference as private readonly field (automatic via parameter property syntax). 3. Initializes requesterId to null (no client connected yet). 4. Ready to bind a client via bindRequester() when client connects.
 *
 * @remarks
 * : Constructor — Initializes WorkspaceManager with RSocket bridge.
 * Parameters: Note: Uses TypeScript parameter property syntax: `private readonly bridge: ClientBridge` automatically creates and assigns the field without explicit body code.
 *
 * @param bridge - RSocket bridge for client communication.
 */
  constructor(private readonly bridge: ClientBridge) {}

  /**
 * Stores the requesterId so that subsequent workspace operations know which client to route to. How it does it (step by step): 1. Receives requesterId from the newly connected client. 2. Stores it in the instance's private requesterId field. 3. Subsequent operations can now use this requesterId to send commands via bridge.
 *
 * @remarks
 * : bindRequester — Registers a client session identifier.
 *
 * @param requesterId - Unique client session identifier from RSocket metadata.
 */
  bindRequester = (requesterId: string): void => {
    this.requesterId = requesterId;
  };

  /**
 * Ensures a client is bound to this workspace manager, throwing an error if not. Used by all workspace operations to guarantee safe routing. How it does it (step by step): 1. Checks if requesterId is set (null check). 2. If not set, throws WorkspaceError with code NO_ROOT. 3. If set, returns the requesterId for use in bridge.request().
 *
 * @remarks
 * : requireRequester — Validates and returns the bound client session identifier.
 *
 * @returns Valid requesterId guaranteed to be non-null.
 * @throws {@link Error} — code: "NO_ROOT" if no client session is bound.
 */
  private requireRequester = (): string => {
    if (this.state === "DISPOSED") {
      throw new WorkspaceError(
        "DISPOSED",
        "WorkspaceManager has been disposed",
      );
    }
    if (!this.requesterId) {
      throw new WorkspaceError("NO_ROOT", "No client session bound");
    }
    return this.requesterId;
  };

  /**
 * Changes the current working directory on the client side by sending a file.cd command. How it does it (step by step): 1. Validates that a client session is bound (requireRequester). 2. Prepares a file.cd command with the target workspacePath. 3. Sends the command via ClientBridge to the connected client. 4. Waits for the response (asynchronous operation). 5. Returns when the client confirms the directory change.
 *
 * @remarks
 * : setRoot — Sets the working directory for the connected client.
 *
 * @param workspacePath - Absolute path to set as the client's working directory.
 * @throws {@link Error} — code: "NO_ROOT" if no client session is bound.
 */
  setRoot = async (workspacePath: string): Promise<void> => {
    const id = this.requireRequester();
    await this.bridge.request(id, "file.cd", { path: workspacePath });
  };

  /**
 * Converts a relative path into an absolute path for file operations. Currently a pass-through that returns the path unchanged (server-side resolution). How it does it (step by step): 1. Receives a relative path string as input. 2. Returns it unchanged (resolution happens on client side via file operations). 3. Placeholder for future path resolution logic if needed on server side.
 *
 * @remarks
 * : resolvePath — Resolves a relative path to its absolute form.
 * Returns: Note: This method is a placeholder for potential future server-side path resolution. Client-side path resolution happens naturally during file operations.
 *
 * @param relativePath - Path that may be relative or absolute.
 * @returns Path (currently returned unchanged).
 */
  resolvePath = (relativePath: string): string => {
    return relativePath;
  };

  /**
 * Retrieves the full content of a file from the client via RSocket bridge, with optional operation logging for experience recording. How it does it (step by step): 1. Validates that a client session is bound (requireRequester). 2. Sends a file.read command to the client with the file path. 3. Awaits the response containing the file content. 4. If context with recorder is provided, logs this read operation. 5. Returns the file content string.
 *
 * @remarks
 * : readFile — Reads file content from the connected client's workspace.
 *
 * @param filePath - Path to the file to read.
 * @param ctx - Optional context with recorder/taskId for logging.
 * @returns File content as string.
 * @throws {@link Error} — code: "NO_ROOT" if no client session is bound.
 * @throws — Network or file operation errors from ClientBridge.
 */
  readFile = async (
    filePath: string,
    ctx?: WorkspaceRecorderContext,
  ): Promise<string> => {
    const id = this.requireRequester();
    const data = await this.bridge.request<{ content: string }>(
      id,
      "file.read",
      { path: filePath },
    );
    if (ctx?.recorder && ctx.taskId) {
      ctx.recorder.logRead(ctx.taskId, filePath);
    }
    return data.content;
  };

  /**
 * Sends file content to the client to write to disk, returning the diff if accepted. Client can accept or reject (e.g., if file is locked), with optional operation logging. How it does it (step by step): 1. Validates that a client session is bound (requireRequester). 2. Sends a file.write command to the client with file path and content. 3. Awaits response containing accepted flag and optional diff. 4. If client rejected the write, returns undefined. 5. If context with recorder is provided, logs this write operation. 6. Returns the diff string (what changed) or undefined if rejected.
 *
 * @remarks
 * : writeFile — Writes content to a file in the connected client's workspace.
 *
 * @param filePath - Path to the file to write.
 * @param content - Full file content to write.
 * @param ctx - Optional context with recorder/taskId for logging.
 * @returns Diff of changes if accepted, undefined if rejected.
 * @throws {@link Error} — code: "NO_ROOT" if no client session is bound.
 * @throws — Network or file operation errors from ClientBridge.
 */
  writeFile = async (
    filePath: string,
    content: string,
    ctx?: WorkspaceRecorderContext,
  ): Promise<string | undefined> => {
    const id = this.requireRequester();
    const data = await this.bridge.request<{
      accepted: boolean;
      diff?: string;
    }>(id, "file.write", { path: filePath, content });
    if (!data.accepted) {
      return undefined;
    }
    const diff = data.diff ?? "";
    if (ctx?.recorder && ctx.taskId && diff.length > 0) {
      ctx.recorder.logWrite(ctx.taskId, filePath, diff);
    }
    return diff;
  };

  /**
   * Applies a surgical in-place edit after reading current content.
   * @throws {Error} When anchor is missing or ambiguous.
   */
  editFile = async (
    filePath: string,
    oldText: string,
    newText: string,
    replaceAll = false,
    ctx?: WorkspaceRecorderContext,
  ): Promise<string | undefined> => {
    if (oldText.length === 0) {
      throw new ValidationError("edit_file: old anchor must be non-empty");
    }

    const content = await this.readFile(filePath, ctx);
    let count = 0;
    let searchFrom = 0;
    while (searchFrom <= content.length) {
      const idx = content.indexOf(oldText, searchFrom);
      if (idx === -1) {
        break;
      }
      count += 1;
      searchFrom = idx + oldText.length;
    }

    if (count === 0) {
      const hint = buildEditAnchorHint(content, oldText);
      throw new NotFoundError(
        `edit_file: anchor not found in "${filePath}".${hint}`,
      );
    }

    if (!replaceAll && count > 1) {
      throw new ValidationError(
        `edit_file: old appears ${count} times in "${filePath}"; add more context or set replace_all: true`,
      );
    }

    const updated = replaceAll
      ? content.split(oldText).join(newText)
      : content.replace(oldText, newText);

    return this.writeFile(filePath, updated, ctx);
  };

  /**
 * Fetches a text representation of the directory tree from the client, with optional depth limit to control how deep the tree goes. How it does it (step by step): 1. Validates that a client session is bound (requireRequester). 2. Sends a file.list_dir command to the client with depth parameter. 3. Awaits response containing text representation of the directory tree. 4. Returns the text representation for display or parsing.
 *
 * @remarks
 * : listStructure — Retrieves the directory structure of the workspace.
 *
 * @param depth - Maximum depth of directory tree to retrieve.
 * @returns Text representation of directory structure.
 * @throws {@link Error} — code: "NO_ROOT" if no client session is bound.
 * @throws — Network or file operation errors from ClientBridge.
 */
  listStructure = async (depth: number): Promise<string> => {
    const id = this.requireRequester();
    const data = await this.bridge.request<{ text: string }>(
      id,
      "file.list_dir",
      { depth },
    );
    return data.text;
  };

  /**
 * Finds all files matching a given pattern (e.g., glob, regex) in the client's workspace and returns their paths. How it does it (step by step): 1. Validates that a client session is bound (requireRequester). 2. Sends a file.search command to the client with the search pattern. 3. Awaits response containing array of matching file paths. 4. Returns the array of paths for further processing.
 *
 * @remarks
 * : searchFiles — Searches for files matching a pattern in the workspace.
 *
 * @param pattern - Search pattern (glob, regex, or file name).
 * @returns Array of file paths matching the pattern.
 * @throws {@link Error} — code: "NO_ROOT" if no client session is bound.
 * @throws — Network or file operation errors from ClientBridge.
 */
  searchFiles = async (pattern: string): Promise<string[]> => {
    const id = this.requireRequester();
    const data = await this.bridge.request<{ paths: string[] }>(
      id,
      "file.search",
      { pattern },
    );
    return data.paths;
  };

  callMcpTool = async (
    tool: string,
    args: unknown,
    timeoutMs?: number,
  ): Promise<{ isError: boolean; data?: unknown; errorMessage?: string }> => {
    const id = this.requireRequester();
    return this.bridge.request(id, "mcp.call", { tool, arguments: args }, timeoutMs);
  };

  /**
 * Sets state to DISPOSED and clears requesterId to prevent accidental use after disposal. How it does it (step by step): 1. Sets state to DISPOSED. 2. Sets requesterId to null. 3. Subsequent operations will throw DISPOSED errors.
 *
 * @remarks
 * : dispose — Cleans up workspace manager resources.
 */
  dispose = (): void => {
    this.state = "DISPOSED";
    this.requesterId = null;
  };
}
