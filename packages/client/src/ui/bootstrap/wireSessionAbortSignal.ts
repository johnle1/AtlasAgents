import type { Connection } from "../../connection/index.js";
import type { LocalFileProxy } from "../../localFileProxy.js";

/** Wires the RSocket session abort signal into the local file proxy. */
export const wireSessionAbortSignal = (
  connection: Connection,
  fileProxy: LocalFileProxy,
): void => {
  fileProxy.setSessionAbortSignal(() => connection.getSessionAbortSignal());
};
