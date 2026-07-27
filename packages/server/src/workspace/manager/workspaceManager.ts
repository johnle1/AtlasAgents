/**
 * Proxies workspace operations (read, write, list, search) from server to a connected CLI client via RSocket bridge.
 *
 * @remarks
 * This class acts as a remote file system abstraction that routes all workspace operations
 * (file reads, writes, edits, directory listing, and file searching) through a {@link ClientBridge}
 * to a single connected CLI client. This design allows the server to maintain zero knowledge
 * of the actual file system layout and delegate all I/O to the client.
 *
 * **Lifecycle:**
 * 1. Constructor accepts a ClientBridge (typically injected via dependency injection)
 * 2. {@link bindRequester} must be called with a client session ID before any operations can proceed
 * 3. All operations validate the requester is bound and the manager hasn't been disposed
 * 4. {@link dispose} should be called when the session ends to free resources
 *
 * **Operation logging:**
 * If a {@link WorkspaceRecorderContext} is passed to read/write/edit operations, the manager
 * logs those operations for audit/replay purposes. Pass `undefined` or omit the context to skip logging.
 *
 * **Path safety:**
 * All paths are validated via {@link assertRelativeWorkspacePath} to prevent directory traversal
 * attacks and ensure paths are workspace-relative (not absolute).
 *
 * @example
 * ```ts
 * const bridge = new ClientBridge(...);
 * const manager = new WorkspaceManager(bridge);
 *
 * // Bind the manager to a specific client session
 * manager.bindRequester("client_abc123");
 *
 * // Read a file
 * const content = await manager.readFile("src/index.ts");
 *
 * // Write a file
 * const outcome = await manager.writeFile("src/index.ts", "new content");
 * if (!outcome.accepted) {
 *   console.log("Write rejected:", outcome.feedback);
 * }
 *
 * // Edit with a surgical replacement
 * const editOutcome = await manager.editFile(
 *   "src/index.ts",
 *   "old code snippet",
 *   "new code snippet"
 * );
 * ```
 *
 * @see {@link ClientBridge} for the transport mechanism
 * @see {@link WorkspaceRecorderContext} for optional logging configuration
 */

import type { ClientBridge } from "../../transport/clientBridge.js";
import * as path from "node:path";
import { buildEditAnchorHint } from "../execution/editFileHelpers.js";
import { NotFoundError, ValidationError } from "../../errors/index.js";
import {
  type WorkspaceRecorderContext,
  type FileWriteOutcome,
  WorkspaceError,
} from "./types.js";

/**
 * Options for {@link WorkspaceManager.editFile} method.
 */
type EditFileOptions = {
  /** If true, replace all occurrences of oldText. If false, oldText must appear exactly once. */
  replaceAll?: boolean;
  /** Optional context for logging this operation. */
  ctx?: WorkspaceRecorderContext;
};

/**
 * Validates and sanitizes a file path to prevent directory traversal and ensure it is workspace-relative.
 *
 * @remarks
 * This validation is critical for security — prevents attackers from using `../../etc/passwd`
 * or absolute paths to access files outside the workspace root. All workspace operations
 * must pass paths through this function before sending to the client.
 *
 * **Rules enforced:**
 * - Path must not be empty after trimming whitespace
 * - Path must be relative (not starting with `/` or `C:\` on Windows)
 * - Path must not contain `..` segments (even if surrounded by slashes)
 * - Both forward slashes `/` and backslashes `\` are normalized
 *
 * @param filePath - The file path to validate, e.g. `"src/index.ts"` or `"packages/core/README.md"`
 * @param field - The name of the field being validated, used in error messages for clarity.
 *   Defaults to `"path"`, but can be customized to `"oldPath"`, `"outputFile"`, etc.
 * @returns The trimmed, validated path ready to send to the client.
 * @throws {@link ValidationError} if path is empty, absolute, or contains `..` segments.
 *   Error messages include the field name for context.
 *
 * @example
 * ```ts
 * // Valid paths
 * assertRelativeWorkspacePath("src/index.ts");           // ✓
 * assertRelativeWorkspacePath("  README.md  ");          // ✓ (whitespace trimmed)
 * assertRelativeWorkspacePath("deep/nested/file.json");  // ✓
 *
 * // Invalid paths (throw ValidationError)
 * assertRelativeWorkspacePath("");                       // ✗ empty
 * assertRelativeWorkspacePath("/etc/passwd");            // ✗ absolute
 * assertRelativeWorkspacePath("../../secret.txt");       // ✗ contains '..'
 * assertRelativeWorkspacePath("src/../etc/passwd");      // ✗ contains '..'
 * ```
 */
const assertRelativeWorkspacePath = (
  filePath: string,
  field = "path",
): string => {
  const trimmed = filePath.trim();
  // Reject empty paths — the caller must provide a non-empty path.
  if (!trimmed) {
    throw new ValidationError(`${field} is required`);
  }
  // Reject absolute paths — all workspace paths must be relative to the workspace root.
  if (path.isAbsolute(trimmed)) {
    throw new ValidationError(
      `${field} must be relative to the workspace root`,
    );
  }
  // Reject paths containing '..' segments — prevents escaping the workspace directory.
  const segments = trimmed.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    throw new ValidationError(`${field} must not contain '..' segments`);
  }
  return trimmed;
};

export class WorkspaceManager {
  /**
   * The ID of the currently bound client session, or null if no session is bound yet.
   * Set via {@link bindRequester} when a client connects.
   */
  private requesterId: string | null = null;

  /**
   * Tracks whether this manager has been disposed. Once "DISPOSED", all operations
   * will throw an error. This prevents accidental reuse after cleanup.
   */
  private state: "ACTIVE" | "DISPOSED" = "ACTIVE";

  /**
   * Creates a new WorkspaceManager.
   *
   * @param bridge - The ClientBridge transport layer used to send file commands
   *   to the connected CLI client. The bridge must be properly initialized and
   *   ready to handle requests before this manager is used.
   *
   * @remarks
   * The manager is created in an "unbound" state. {@link bindRequester} must be
   * called before any file operations will succeed. This allows the manager to be
   * instantiated before a client connection is established.
   *
   * @example
   * ```ts
   * const bridge = new ClientBridge(...);
   * const manager = new WorkspaceManager(bridge);
   * // Now call manager.bindRequester(...) when client connects
   * ```
   */
  constructor(private readonly bridge: ClientBridge) {}

  /**
   * Binds this manager to a specific client session ID.
   *
   * @remarks
   * This method must be called exactly once after construction and before any file operations.
   * Binding associates all subsequent operations with the given client session. If this is
   * called multiple times, the previous requesterId is silently overwritten.
   *
   * In a multi-client server, each client would have its own WorkspaceManager instance
   * bound to its own session ID, so each client's file operations are isolated.
   *
   * @param requesterId - The unique session ID of the connected client, e.g. "client_abc123".
   *   This ID is used as the recipient address when routing requests through the ClientBridge.
   *
   * @example
   * const manager = new WorkspaceManager(bridge);
   * manager.bindRequester("client_session_xyz");
   *
   * // Now operations will route to that client
   * const content = await manager.readFile("README.md");
   */
  bindRequester = (requesterId: string): void => {
    this.requesterId = requesterId;
  };

  /**
   * Ensures the manager is in a valid state for operations and returns the bound requester ID.
   *
   * @remarks
   * This is a guard method called at the start of every operation to validate preconditions:
   * 1. The manager hasn't been disposed (state is still "ACTIVE")
   * 2. A client session has been bound (requesterId is set)
   *
   * If either condition fails, a {@link WorkspaceError} is thrown with a descriptive code
   * and message. This prevents silent failures or operations routing to undefined clients.
   *
   * @returns The requesterId string if both conditions pass.
   * @throws {@link WorkspaceError} with code "DISPOSED" if the manager has been disposed.
   * @throws {@link WorkspaceError} with code "NO_ROOT" if no client session is bound.
   *
   * @example
   * // This is only called internally before operations:
   * // const id = this.requireRequester(); // Throws if not ready
   * // await this.bridge.request(id, ...);
   */
  private requireRequester = (): string => {
    // Check if this manager has been cleaned up already.
    if (this.state === "DISPOSED") {
      throw new WorkspaceError(
        "DISPOSED",
        "WorkspaceManager has been disposed",
      );
    }
    // Check if a client session is bound. Without this, we have nowhere to route requests.
    if (!this.requesterId) {
      throw new WorkspaceError("NO_ROOT", "No client session bound");
    }
    return this.requesterId;
  };

  /**
   * Changes the working directory for the bound client session to the specified workspace path.
   *
   * @remarks
   * This operation tells the client to change its internal working directory. All subsequent
   * relative file paths sent by the server are resolved from this new root. This is typically
   * called once when a workspace is opened to anchor subsequent file operations.
   *
   * The path is NOT validated (unlike file paths in read/write/edit), so the client is
   * responsible for ensuring the path exists and is accessible.
   *
   * @param workspacePath - The absolute or relative path to set as the new working directory,
   *   e.g. "/home/user/my-project" or ".".
   * @throws {@link WorkspaceError} if the manager is disposed or no client is bound.
   * @throws If the client cannot change to the specified directory (delegated to client).
   *
   * @example
   * await manager.setRoot("/home/user/projects/my-app");
   * // Now manager.readFile("src/index.ts") resolves to /home/user/projects/my-app/src/index.ts
   */
  setRoot = async (workspacePath: string): Promise<void> => {
    const id = this.requireRequester();
    await this.bridge.request(id, "file.cd", { path: workspacePath });
  };

  /**
   * Resolves a relative workspace path to an absolute file system path.
   *
   * @remarks
   * In the current implementation, this is a pass-through that returns the input unchanged.
   * The server maintains zero knowledge of the actual file system layout — all resolution
   * is delegated to the client. This method exists as a placeholder for future path resolution
   * logic or as a normalization point if needed.
   *
   * Callers typically use this before storing paths in logs or error messages to ensure
   * consistency and clarity about what path was actually used.
   *
   * @param relativePath - A workspace-relative path, typically already validated via
   *   {@link assertRelativeWorkspacePath}.
   * @returns The resolved path. Currently returns the input unchanged.
   *
   * @example
   * const resolvedPath = manager.resolvePath("src/index.ts");
   * console.log("File: " + resolvedPath);
   */
  resolvePath = (relativePath: string): string => {
    return relativePath;
  };

  /**
   * Reads and returns the entire contents of a file.
   *
   * @remarks
   * This method sends a read request to the bound client, which retrieves the file from the
   * actual file system and returns its contents as a string. The entire file is loaded into
   * memory, so this is not suitable for very large files (use streaming for that if needed).
   *
   * **Path validation:** The path is validated via {@link assertRelativeWorkspacePath} to prevent
   * directory traversal attacks before sending to the client.
   *
   * **Operation logging:** If a {@link WorkspaceRecorderContext} is provided with a recorder
   * and taskId, this read operation is logged for audit or replay purposes.
   *
   * @param filePath - The workspace-relative path to the file, e.g. "src/index.ts".
   *   Must not be absolute or contain ".." segments.
   * @param ctx - Optional context for logging this operation. If provided with a recorder
   *   and taskId, the read is logged for audit purposes.
   * @returns The file contents as a string (UTF-8 assumed).
   * @throws {@link ValidationError} if the path is invalid (absolute, empty, or contains "..").
   * @throws {@link WorkspaceError} if the manager is disposed or no client is bound.
   * @throws If the file doesn't exist or can't be read (delegated to client).
   *
   * @example
   * const content = await manager.readFile("package.json");
   * console.log(content); // File contents as string
   *
   * // With logging
   * const content = await manager.readFile("src/index.ts", {
   *   recorder: auditLog,
   *   taskId: "task_123"
   * });
   * // The read operation is now recorded for audit purposes
   */
  readFile = async (
    filePath: string,
    ctx?: WorkspaceRecorderContext,
  ): Promise<string> => {
    // Validate and sanitize the path to prevent directory traversal.
    const safePath = assertRelativeWorkspacePath(filePath);
    const id = this.requireRequester();
    // Send a read request to the client and wait for the file contents.
    const data = await this.bridge.request<{ content: string }>(
      id,
      "file.read",
      { path: safePath },
    );
    // Log this operation if a recorder context was provided.
    if (ctx?.recorder && ctx.taskId) {
      ctx.recorder.logRead(ctx.taskId, safePath);
    }
    return data.content;
  };

  /**
   * Writes content to a file, replacing its entire contents. May be rejected by the client.
   *
   * @remarks
   * This method sends content to the client for writing. The client may accept or reject
   * the write (e.g., if the file is currently open for editing or a conflict is detected).
   * A rejection is not an error — the caller receives { accepted: false, feedback: "reason" }
   * and must decide how to proceed.
   *
   * **Path validation:** The path is validated via {@link assertRelativeWorkspacePath} before sending.
   *
   * **Client feedback:** If the write is rejected, feedback contains a human-readable reason.
   * If accepted, diff contains a unified diff showing the changes (if available).
   *
   * **Operation logging:** The write is logged only if accepted and contains actual changes.
   * Empty diffs are not logged.
   *
   * @param filePath - The workspace-relative path to the file, e.g. "src/index.ts".
   * @param content - The new file contents to write (UTF-8).
   * @param ctx - Optional context for logging. Write operations are only logged if accepted
   *   and the diff is non-empty.
   * @returns {@link FileWriteOutcome} indicating acceptance, with optional diff and feedback.
   * @throws {@link ValidationError} if the path is invalid.
   * @throws {@link WorkspaceError} if the manager is disposed or no client is bound.
   *
   * @example
   * const outcome = await manager.writeFile("src/index.ts", "console.log('hello');");
   * if (outcome.accepted) {
   *   console.log("Write succeeded. Diff:", outcome.diff);
   * } else {
   *   console.log("Write rejected:", outcome.feedback);
   * }
   *
   * // With logging
   * const outcome = await manager.writeFile("src/index.ts", newContent, {
   *   recorder: auditLog,
   *   taskId: "task_123"
   * });
   */
  writeFile = async (
    filePath: string,
    content: string,
    ctx?: WorkspaceRecorderContext,
  ): Promise<FileWriteOutcome> => {
    // Validate the path to prevent directory traversal.
    const safePath = assertRelativeWorkspacePath(filePath);
    const id = this.requireRequester();
    // Send the write request to the client. It may accept or reject the write.
    const data = await this.bridge.request<{
      accepted: boolean;
      diff?: string;
      feedback?: string;
    }>(id, "file.write", { path: safePath, content });
    // If the client rejected the write, return early with the feedback.
    if (!data.accepted) {
      return { accepted: false, feedback: data.feedback };
    }
    // The write was accepted. Now check if we should log it.
    const diff = data.diff ?? "";
    // Only log if we have a non-empty diff. Empty diffs mean no changes were actually made.
    if (ctx?.recorder && ctx.taskId && diff.length > 0) {
      ctx.recorder.logWrite(ctx.taskId, safePath, diff);
    }
    return { accepted: true, diff };
  };

  /**
   * Performs a surgical in-place text replacement in a file after reading current content.
   *
   * @remarks
   * This method implements a "find-and-replace" operation that works by:
   * 1. Reading the current file content
   * 2. Counting occurrences of the old text anchor
   * 3. Validating that the anchor is unambiguous (unless `replaceAll` is true)
   * 4. Performing the replacement
   * 5. Writing the updated content back via {@link writeFile}
   *
   * **Anchor ambiguity:** If `oldText` appears multiple times and `replaceAll` is false,
   * an error is thrown with a helpful hint (via {@link buildEditAnchorHint}) suggesting
   * adding more context to make the anchor unique. This prevents silent incorrect replacements.
   *
   * **Logging:** The operation is logged as a single write via {@link writeFile}, which
   * means it inherits the logging behavior of file writes — only logged if the diff is non-empty.
   *
   * @param filePath - The workspace-relative path to the file to edit, e.g. "src/index.ts".
   * @param oldText - The exact text to find and replace. Must be non-empty. If this text
   *   appears multiple times and options.replaceAll is false, an error is thrown.
   * @param newText - The replacement text. Can be empty to delete the oldText segment.
   * @param options - Optional configuration for the edit operation.
   *   - replaceAll: If true, all occurrences of oldText are replaced. If false (default),
   *     oldText must appear exactly once to avoid ambiguous replacements.
   *   - ctx: Optional context for logging the resulting write operation.
   * @returns {@link FileWriteOutcome} indicating whether the write succeeded, with optional diff.
   * @throws {@link ValidationError} if oldText is empty.
   * @throws {@link ValidationError} if oldText appears multiple times and replaceAll is false.
   * @throws {@link NotFoundError} if oldText is not found in the file. Includes a hint from
   *   {@link buildEditAnchorHint} suggesting similar text.
   * @throws {@link ValidationError} if the path is invalid.
   * @throws {@link WorkspaceError} if the manager is disposed or no client is bound.
   *
   * @example
   * // Simple replacement with unique anchor
   * const outcome = await manager.editFile(
   *   "src/index.ts",
   *   "const x = 1;",
   *   "const x = 2;"
   * );
   *
   * // Replace all occurrences of a common pattern
   * const outcome = await manager.editFile(
   *   "src/index.ts",
   *   "console.log",
   *   "logger.info",
   *   { replaceAll: true }
   * );
   *
   * // Delete a line by replacing with empty string
   * const outcome = await manager.editFile(
   *   "src/index.ts",
   *   "// TODO: remove this\nconst x = 1;",
   *   "const x = 1;"
   * );
   *
   * // With logging context
   * const outcome = await manager.editFile(
   *   "src/index.ts",
   *   "oldSnippet",
   *   "newSnippet",
   *   { replaceAll: true, ctx: { recorder, taskId } }
   * );
   *
   * @see {@link buildEditAnchorHint} for the hint generation logic
   */
  editFile = async (
    filePath: string,
    oldText: string,
    newText: string,
    options?: EditFileOptions,
  ): Promise<FileWriteOutcome> => {
    const { replaceAll = false, ctx } = options ?? {};

    // Validate the file path.
    const safePath = assertRelativeWorkspacePath(filePath);
    // The oldText anchor must be non-empty; an empty anchor is meaningless.
    if (oldText.length === 0) {
      throw new ValidationError("edit_file: old anchor must be non-empty");
    }

    // Read the current file content to search for the anchor.
    const content = await this.readFile(safePath, ctx);
    // Count all occurrences of the old text in the file to check for ambiguity.
    let count = 0;
    let searchFrom = 0;
    while (searchFrom <= content.length) {
      const matchIndex = content.indexOf(oldText, searchFrom);
      if (matchIndex === -1) {
        break;
      }
      count += 1;
      // Move search position past this occurrence to find the next one.
      searchFrom = matchIndex + oldText.length;
    }

    // If the anchor text isn't found at all, throw an error with a helpful hint.
    if (count === 0) {
      const hint = buildEditAnchorHint(content, oldText);
      throw new NotFoundError(
        `edit_file: anchor not found in "${safePath}".${hint}`,
      );
    }

    // If the anchor appears multiple times and replaceAll is false, reject the edit to prevent mistakes.
    if (!replaceAll && count > 1) {
      throw new ValidationError(
        `edit_file: old appears ${count} times in "${safePath}"; add more context or set replace_all: true`,
      );
    }

    // Perform the actual replacement. Use split/join for replaceAll to be explicit; use replace for single.
    const updated = replaceAll
      ? content.split(oldText).join(newText)
      : content.replace(oldText, newText);

    // Write the updated content back to the file.
    return this.writeFile(safePath, updated, ctx);
  };

  /**
   * Lists the workspace directory structure up to a specified depth.
   *
   * @remarks
   * This operation requests a tree-like listing of the workspace directory from the client.
   * The listing is returned as a formatted text string (typically with indentation to show
   * hierarchy). Depth controls how many levels of nesting are included:
   * - depth: 1 shows only the workspace root contents (1 level)
   * - depth: 2 shows root and immediate children (2 levels)
   * - etc.
   *
   * Use this to display the project structure to the user or for navigation purposes.
   *
   * @param depth - The maximum directory nesting level to include in the listing.
   *   Must be a positive integer. Behavior with 0 or negative values is undefined.
   * @returns A formatted text string representing the directory tree, with file names,
   *   directories, and visual hierarchy markers (typically ASCII tree characters).
   * @throws {@link WorkspaceError} if the manager is disposed or no client is bound.
   * @throws If the workspace root is inaccessible (delegated to client).
   *
   * @example
   * const structure = await manager.listStructure(3);
   * console.log(structure);
   * // Output:
   * // src/
   * //   index.ts
   * //   utils/
   * //     helper.ts
   * // package.json
   * // README.md
   */
  listStructure = async (depth: number): Promise<string> => {
    const id = this.requireRequester();
    // Request a directory listing from the client with the specified depth limit.
    const data = await this.bridge.request<{ text: string }>(
      id,
      "file.list_dir",
      { depth },
    );
    return data.text;
  };

  /**
   * Searches for files matching a glob or text pattern in the workspace.
   *
   * @remarks
   * This method sends a search request to the client, which performs the actual file system
   * search. The pattern syntax depends on the client implementation — typically glob patterns
   * (e.g. "*.ts", "src/**\/*.test.ts") or text-search patterns.
   *
   * Results are returned as an array of workspace-relative file paths. The search is
   * performed on the client side, so performance depends on workspace size and client capabilities.
   *
   * @param pattern - A search pattern, typically a glob (e.g. "**\/*.ts", "*.json").
   *   The exact pattern syntax is determined by the client implementation.
   * @returns An array of workspace-relative paths matching the pattern. Returns an empty
   *   array if no matches are found.
   * @throws {@link WorkspaceError} if the manager is disposed or no client is bound.
   * @throws If the search fails (delegated to client).
   *
   * @example
   * // Find all TypeScript files
   * const tsFiles = await manager.searchFiles("**\/*.ts");
   * console.log(tsFiles); // ["src/index.ts", "src/utils/helper.ts", ...]
   *
   * // Find all test files
   * const tests = await manager.searchFiles("**\/*.test.ts");
   * console.log(tests.length); // 42
   */
  searchFiles = async (pattern: string): Promise<string[]> => {
    const id = this.requireRequester();
    // Send the search pattern to the client and retrieve matching file paths.
    const data = await this.bridge.request<{ paths: string[] }>(
      id,
      "file.search",
      { pattern },
    );
    return data.paths;
  };

  /**
   * Calls a Model Context Protocol (MCP) tool on the client side.
   *
   * @remarks
   * This method bridges to MCP tools available on the client, allowing the server
   * to invoke client-side capabilities dynamically. The tool name and arguments are
   * sent to the client, which handles the actual invocation. Results include both
   * success responses and error states, all returned in a single result object.
   *
   * **Timeouts:** An optional timeout can be specified to prevent hung requests.
   * If the timeout is exceeded, the request throws or returns an error (depending on
   * the bridge implementation).
   *
   * @param tool - The name of the MCP tool to invoke, e.g. "filesystem.read", "search.query".
   * @param args - The tool arguments, typically an object. The structure depends on the specific tool.
   * @param timeoutMs - Optional timeout in milliseconds. If the client doesn't respond
   *   within this time, the request fails. Omit for no timeout.
   * @returns A result object containing:
   *   - isError: boolean indicating success (false) or failure (true)
   *   - data: The tool's return value (if isError is false)
   *   - errorMessage: Description of the error (if isError is true)
   * @throws {@link WorkspaceError} if the manager is disposed or no client is bound.
   * @throws If the bridge request fails or times out.
   *
   * @example
   * const result = await manager.callMcpTool("filesystem.stat", { path: "README.md" });
   * if (result.isError) {
   *   console.log("Error:", result.errorMessage);
   * } else {
   *   console.log("File stats:", result.data);
   * }
   *
   * // With timeout
   * const result = await manager.callMcpTool(
   *   "search.query",
   *   { pattern: "TODO" },
   *   5000  // 5 second timeout
   * );
   */
  callMcpTool = async (
    tool: string,
    args: unknown,
    timeoutMs?: number,
  ): Promise<{ isError: boolean; data?: unknown; errorMessage?: string }> => {
    const id = this.requireRequester();
    // Route the MCP tool call to the client via the bridge.
    return this.bridge.request(
      id,
      "mcp.call",
      { tool, arguments: args },
      timeoutMs,
    );
  };

  /**
   * Cleans up this WorkspaceManager and prevents further operations.
   *
   * @remarks
   * This method marks the manager as disposed, freeing resources and preventing accidental
   * reuse after a session ends. Any operations attempted after dispose will throw
   * a {@link WorkspaceError} with code "DISPOSED".
   *
   * Call this when the client session terminates to ensure clean resource cleanup and
   * prevent silent failures from stale manager references.
   *
   * @example
   * manager.dispose();
   * // Now any call to manager.readFile() will throw WorkspaceError("DISPOSED", ...)
   */
  dispose = (): void => {
    // Mark the manager as disposed so future operations will be rejected.
    this.state = "DISPOSED";
    // Clear the requester ID to be thorough (defensive programming).
    this.requesterId = null;
  };
}
