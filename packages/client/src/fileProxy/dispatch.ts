import type { ClientRoute } from "@loopycode/shared";
import type { DispatchContext } from "./types.js";
import {
  handleFileCd,
  handleFileCreateDir,
  handleFileDeleteDir,
  handleFileDeleteFile,
  handleFileGetCwd,
  handleFileListDir,
  handleFileRead,
  handleFileSearch,
  handleFileWrite,
} from "./handlers/fileHandlers.js";
import {
  handleCommandClassify,
  handleCommandRun,
} from "./handlers/commandHandlers.js";

/**
 * <Summary>
 * What it does:
 *   Routes incoming client requests to the appropriate handler function based on the route name.
 *
 * How it does it (step by step):
 *   1. Cast the unknown payload to a typed record for handler consumption.
 *   2. Use a switch statement to match the route against all known routes.
 *   3. For file operations (read, write, list_dir, search, create_dir, delete_file, delete_dir, cd),
 *     call the corresponding file handler with the context and request body.
 *   4. For the file.get_cwd route, call the handler without a request body (no parameters needed).
 *   5. For command operations (classify, run), call the corresponding command handler with the context
 *     and request body.
 *   6. If the route doesn't match any known route, throw an error indicating an unknown route.
 *   7. Return the result from the appropriate handler function.
 *
 * Parameters:
 *   @param {DispatchContext} context — The dispatch context containing workspace root, current directory,
 *     and other runtime state needed by handlers.
 *   @param {ClientRoute} route — The route identifier that determines which handler to call
 *     (e.g., "file.read", "command.run").
 *   @param {unknown} payload — The request payload containing parameters for the handler (typed as unknown
 *     for flexibility, cast to Record<string, unknown> for handler consumption).
 *
 * Returns:
 *   @returns {Promise<unknown>} — The result from the appropriate handler function (type varies by route).
 *
 * Dependencies:
 *   - handleFileRead — handles file reading requests.
 *   - handleFileWrite — handles file writing requests.
 *   - handleFileListDir — handles directory listing requests.
 *   - handleFileSearch — handles file search requests.
 *   - handleFileCreateDir — handles directory creation requests.
 *   - handleFileDeleteFile — handles file deletion requests.
 *   - handleFileDeleteDir — handles directory deletion requests.
 *   - handleFileCd — handles directory change requests.
 *   - handleFileGetCwd — handles get current working directory requests.
 *   - handleCommandClassify — handles command classification requests.
 *   - handleCommandRun — handles command execution requests.
 *
 * Dependants:
 *   - Proxy request handlers — call this to route incoming client requests to the appropriate handlers.
 *   - Client-server communication layer — uses this as the central routing mechanism.
 * </Summary>
 */
export const dispatch = async (
  context: DispatchContext,
  route: ClientRoute,
  payload: unknown,
): Promise<unknown> => {
  // ===== STEP 1: Cast payload to typed record =====
  // Step 1a: Cast the unknown payload to a Record<string, unknown> for handler consumption
  // Step 1b: This allows handlers to access named parameters from the request body
  const requestBody = payload as Record<string, unknown>;

  // ===== STEP 2: Route to appropriate handler =====
  // Step 2a: Use switch statement to match the route and call the corresponding handler
  switch (route) {
    // ===== FILE OPERATION ROUTES =====
    // Step 2b: File read operation - read file contents
    case "file.read":
      return handleFileRead(context, requestBody);

    // Step 2c: File write operation - write content to file
    case "file.write":
      return handleFileWrite(context, requestBody);

    // Step 2d: Directory listing operation - list directory contents
    case "file.list_dir":
      return handleFileListDir(context, requestBody);

    // Step 2e: File search operation - search for files matching patterns
    case "file.search":
      return handleFileSearch(context, requestBody);

    // Step 2f: Directory creation operation - create a new directory
    case "file.create_dir":
      return handleFileCreateDir(context, requestBody);

    // Step 2g: File deletion operation - delete a file
    case "file.delete_file":
      return handleFileDeleteFile(context, requestBody);

    // Step 2h: Directory deletion operation - delete a directory
    case "file.delete_dir":
      return handleFileDeleteDir(context, requestBody);

    // Step 2i: Directory change operation - change current working directory
    case "file.cd":
      return handleFileCd(context, requestBody);

    // Step 2j: Get current working directory operation - no request body needed
    case "file.get_cwd":
      return handleFileGetCwd(context);

    // ===== COMMAND OPERATION ROUTES =====
    // Step 2k: Command classification operation - classify command safety level
    case "command.classify":
      return handleCommandClassify(context, requestBody);

    // Step 2l: Command execution operation - run a shell command
    case "command.run":
      return handleCommandRun(context, requestBody);

    // ===== UNKNOWN ROUTE HANDLING =====
    // Step 2m: If route doesn't match any known route, throw an error
    default:
      throw new Error(`Unknown route: ${route}`);
  }
};
