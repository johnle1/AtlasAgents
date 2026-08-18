/** Public module entry — re-exports the client file-proxy implementation. */
export type { ClientRoute, ClientOpResponse } from "@atlasagents/shared";
export { LocalFileProxy } from "./fileProxy/index.js";
export type { DispatchContext, ShellResult } from "./fileProxy/types.js";
