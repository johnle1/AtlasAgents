/**
 * Unit tests — client commands/providerHandlers.ts
 *
 * Confirms `/providers list|remove` parse arguments correctly and send
 * the right route + payload to the server, using a faked Connection (only
 * `sendCommand` is exercised, matching the pattern used elsewhere for
 * Connection-dependent command handlers). There is no `/providers add` —
 * providers are added by editing the server's config directly.
 */

import { describe, expect, it, vi } from "vitest";
import { handleProviders } from "../../../../packages/client/src/commands/providerHandlers";
import type { Connection } from "../../../../packages/client/src/connection/index";

const fakeConnection = (
  sendCommand: (type: string, payload: unknown) => Promise<unknown>,
): Connection =>
  ({ sendCommand }) as unknown as Connection;

describe("handleProviders — list", () => {
  it("sends providers.list with an empty payload", async () => {
    const sendCommand = vi.fn(async () => ({
      providers: { "lmstudio": { baseUrl: "http://localhost:1234/v1" } },
      agentProvider: "lmstudio",
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

describe("handleProviders — remove", () => {
  it("sends providers.remove with the trimmed name", async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));

    await handleProviders("remove", "  lmstudio  ", fakeConnection(sendCommand));

    expect(sendCommand).toHaveBeenCalledWith("providers.remove", {
      name: "lmstudio",
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

  it("'add' is no longer a recognized subcommand (regression — /providers add was removed)", async () => {
    const sendCommand = vi.fn(async () => ({ ok: true }));

    await handleProviders(
      "add",
      "lmstudio --url http://localhost:1234/v1",
      fakeConnection(sendCommand),
    );

    expect(sendCommand).not.toHaveBeenCalled();
  });
});
