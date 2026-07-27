/**
 * Unit tests — client commands/providerHandlers.ts
 *
 * Confirms `/providers list|add|remove` parse arguments correctly and send
 * the right route + payload to the server, using a faked Connection (only
 * `sendCommand` is exercised, matching the pattern used elsewhere for
 * Connection-dependent command handlers).
 */

import { describe, expect, it, vi } from "vitest";
import { handleProviders } from "../../../packages/client/src/commands/providerHandlers";
import type { Connection } from "../../../packages/client/src/connection/index";

const fakeConnection = (
  sendCommand: (type: string, payload: unknown) => Promise<unknown>,
): Connection =>
  ({ sendCommand }) as unknown as Connection;

describe("handleProviders — list", () => {
  it("sends providers.list with an empty payload", async () => {
    const sendCommand = vi.fn(async () => ({
      providers: { "vllm-gpu": { baseUrl: "http://localhost:8000/v1" } },
      agentProvider: "vllm-gpu",
      subagentProvider: "ollama",
    }));

    await handleProviders("list", "", fakeConnection(sendCommand));

    expect(sendCommand).toHaveBeenCalledWith("providers.list", {});
  });

  it("does not throw when the server call fails", async () => {
    const sendCommand = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      handleProviders("list", "", fakeConnection(sendCommand)),
    ).resolves.toBeUndefined();
  });
});

describe("handleProviders — add", () => {
  it("parses name, --url, and --key and sends providers.add", async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));

    await handleProviders(
      "add",
      "vllm-gpu --url http://localhost:8000/v1 --key secret",
      fakeConnection(sendCommand),
    );

    expect(sendCommand).toHaveBeenCalledWith("providers.add", {
      name: "vllm-gpu",
      baseUrl: "http://localhost:8000/v1",
      apiKey: "secret",
    });
  });

  it("omits apiKey when --key is not given", async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));

    await handleProviders(
      "add",
      "vllm-gpu --url http://localhost:8000/v1",
      fakeConnection(sendCommand),
    );

    expect(sendCommand).toHaveBeenCalledWith("providers.add", {
      name: "vllm-gpu",
      baseUrl: "http://localhost:8000/v1",
      apiKey: undefined,
    });
  });

  it("does not call the server when --url is missing", async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));

    await handleProviders("add", "vllm-gpu", fakeConnection(sendCommand));

    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("does not call the server when no name is given", async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));

    await handleProviders("add", "", fakeConnection(sendCommand));

    expect(sendCommand).not.toHaveBeenCalled();
  });
});

describe("handleProviders — remove", () => {
  it("sends providers.remove with the trimmed name", async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));

    await handleProviders("remove", "  vllm-gpu  ", fakeConnection(sendCommand));

    expect(sendCommand).toHaveBeenCalledWith("providers.remove", {
      name: "vllm-gpu",
    });
  });

  it("does not call the server when no name is given", async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));

    await handleProviders("remove", "", fakeConnection(sendCommand));

    expect(sendCommand).not.toHaveBeenCalled();
  });
});

describe("handleProviders — unknown subcommand", () => {
  it("does not call the server", async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));

    await handleProviders("bogus", "", fakeConnection(sendCommand));

    expect(sendCommand).not.toHaveBeenCalled();
  });
});
