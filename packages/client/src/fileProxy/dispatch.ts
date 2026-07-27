/**
 * Route table from `ClientRoute` strings to file / command / MCP handlers.
 *
 * @remarks
 * {@link LocalFileProxy.handle} builds a {@link DispatchContext} then calls
 * {@link dispatch}. Unknown routes throw — the proxy turns that into
 * `{ ok: false, error }`.
 */

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
import { handleMcpCall } from "./handlers/mcpHandlers.js";

/**
 * Invokes the handler registered for `route` with `payload`.
 *
 * @remarks
 * `payload` is cast to `Record<string, unknown>` for handlers; each handler
 * validates its own required fields. Exhaustive `switch` over {@link ClientRoute}
 * keeps new routes a compile-time concern when the shared union is updated.
 *
 * @param context - Workspace state + helpers for the current request.
 * @param route - Wire route id (e.g. `"file.read"`, `"command.run"`).
 * @param payload - JSON body from the server-initiated requestResponse.
 * @returns Handler-specific data (wrapped by the proxy as `{ ok: true, data }`).
 * @throws {@link Error} When `route` is not recognized (`Unknown route: …`).
 *
 * @example
 * ```ts
 * const data = await dispatch(context, "file.get_cwd", {});
 * // → { cwd: "/…/workspace" }
 * ```
 */
export const dispatch = async (
  context: DispatchContext,
  route: ClientRoute,
  payload: unknown,
): Promise<unknown> => {
  const requestBody = payload as Record<string, unknown>;

  switch (route) {
    case "file.read":
      return handleFileRead(context, requestBody);

    case "file.write":
      return handleFileWrite(context, requestBody);

    case "file.list_dir":
      return handleFileListDir(context, requestBody);

    case "file.search":
      return handleFileSearch(context, requestBody);

    case "file.create_dir":
      return handleFileCreateDir(context, requestBody);

    case "file.delete_file":
      return handleFileDeleteFile(context, requestBody);

    case "file.delete_dir":
      return handleFileDeleteDir(context, requestBody);

    case "file.cd":
      return handleFileCd(context, requestBody);

    case "file.get_cwd":
      return handleFileGetCwd(context);

    case "command.classify":
      return handleCommandClassify(context, requestBody);

    case "command.run":
      return handleCommandRun(context, requestBody);

    case "mcp.call":
      return handleMcpCall(context, requestBody);

    default:
      throw new Error(`Unknown route: ${route}`);
  }
};
