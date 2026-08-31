/**
 * Picks the six config fields shared with the server's `sync.check` route.
 *
 * @remarks
 * The client and server now use identical names for all six overlapping
 * fields (`agentModel`, `subagentModel`, `agentProvider`, `subagentProvider`,
 * `agentTemp`, `subagentTemp`), so this module is a plain pick/pass-through
 * kept at the one boundary where `sync.check` crosses the wire — no
 * per-field remapping is needed.
 */
import type { Config } from "./types.js";

export type ServerConfigValues = {
  agentModel: string;
  subagentModel: string;
  agentProvider: string;
  subagentProvider: string;
  agentTemp: number;
  subagentTemp: number;
};

export const toServerConfigValues = (config: Config): ServerConfigValues => ({
  agentModel: config.agentModel,
  subagentModel: config.subagentModel,
  agentProvider: config.agentProvider,
  subagentProvider: config.subagentProvider,
  agentTemp: config.agentTemp,
  subagentTemp: config.subagentTemp,
});

export const fromServerConfigValues = (
  values: ServerConfigValues,
): Pick<
  Config,
  | "agentModel"
  | "subagentModel"
  | "agentProvider"
  | "subagentProvider"
  | "agentTemp"
  | "subagentTemp"
> => ({
  agentModel: values.agentModel,
  subagentModel: values.subagentModel,
  agentProvider: values.agentProvider,
  subagentProvider: values.subagentProvider,
  agentTemp: values.agentTemp,
  subagentTemp: values.subagentTemp,
});
