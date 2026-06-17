import type { RSocket } from "@rsocket/core";
import type { Config } from "../config.js";

export const authMetadata = (config: Config): Buffer => {
  const password = config.password ?? "";
  const authEnvelope = { password };
  return Buffer.from(JSON.stringify(authEnvelope), "utf-8");
};

export const requireSocket = (rsocket: RSocket | null): RSocket => {
  if (!rsocket) {
    throw new Error("RSocket is not connected");
  }
  return rsocket;
};
