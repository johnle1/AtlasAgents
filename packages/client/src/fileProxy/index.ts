/**
 * Public barrel for the client file-proxy module.
 *
 * @remarks
 * Prefer this entry (or `../localFileProxy.js`) over deep imports. The primary
 * type is {@link LocalFileProxy}: it sandboxes FS/shell/MCP routes under a
 * workspace root for the RSocket file responder.
 *
 * @example
 * ```ts
 * import { LocalFileProxy } from "./fileProxy/index.js";
 *
 * const proxy = new LocalFileProxy("/home/user/project");
 * const result = await proxy.handle("file.read", { path: "src/index.ts" });
 * → { ok: true, data: { content: "…" } }
 * ```
 */

export type { ClientRoute, ClientOpResponse } from "@loopycode/shared";
export { LocalFileProxy } from "./proxy.js";
export type { DispatchContext, ShellResult } from "./types.js";
