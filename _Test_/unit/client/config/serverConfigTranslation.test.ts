/**
 * Unit tests — client config/serverConfigTranslation.ts
 *
 * @remarks
 * The client and server now use identical names for all six overlapping
 * fields, so this module is a plain pick/pass-through — these tests pin
 * down that the six fields survive the trip in both directions unchanged.
 */

import { describe, expect, it } from "vitest";
import {
  fromServerConfigValues,
  toServerConfigValues,
} from "../../../../packages/client/src/config/serverConfigTranslation.js";
import { DEFAULT_CONFIG } from "../../../../packages/client/src/config/types.js";

describe("toServerConfigValues", () => {
  it("passes the client's agent/subagent model fields through unchanged (normal)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      agentModel: "lead-model-name",
      subagentModel: "worker-model-name",
    };
    const values = toServerConfigValues(config);
    expect(values.agentModel).toBe("lead-model-name");
    expect(values.subagentModel).toBe("worker-model-name");
  });

  it("passes provider and temperature fields through unchanged (normal)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      agentProvider: "lmstudio",
      subagentProvider: "openai",
      agentTemp: 0.2,
      subagentTemp: 0.7,
    };
    const values = toServerConfigValues(config);
    expect(values.agentProvider).toBe("lmstudio");
    expect(values.subagentProvider).toBe("openai");
    expect(values.agentTemp).toBe(0.2);
    expect(values.subagentTemp).toBe(0.7);
  });
});

describe("fromServerConfigValues", () => {
  it("passes the server's agentModel/subagentModel back through unchanged (normal)", () => {
    const patch = fromServerConfigValues({
      agentModel: "server-lead-model",
      subagentModel: "server-worker-model",
      agentProvider: "ollama",
      subagentProvider: "ollama",
      agentTemp: 0.1,
      subagentTemp: 0.4,
    });
    expect(patch.agentModel).toBe("server-lead-model");
    expect(patch.subagentModel).toBe("server-worker-model");
  });
});

describe("toServerConfigValues / fromServerConfigValues round trip", () => {
  it("recovers the original client values after a round trip (normal)", () => {
    const config = {
      ...DEFAULT_CONFIG,
      agentModel: "lead-model-name",
      subagentModel: "worker-model-name",
      agentProvider: "lmstudio",
      subagentProvider: "openai",
      agentTemp: 0.25,
      subagentTemp: 0.65,
    };
    const roundTripped = fromServerConfigValues(toServerConfigValues(config));
    expect(roundTripped).toEqual({
      agentModel: "lead-model-name",
      subagentModel: "worker-model-name",
      agentProvider: "lmstudio",
      subagentProvider: "openai",
      agentTemp: 0.25,
      subagentTemp: 0.65,
    });
  });
});
