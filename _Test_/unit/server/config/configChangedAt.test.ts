/**
 * Unit tests — server config/configManager.ts's configChangedAt stamping.
 *
 * @remarks
 * `configChangedAt` backs the `sync.check` route's newest-wins config
 * reconciliation — it must move ONLY when a field the client also tracks
 * (agent/subagent model, provider, temperature) actually changes, never on
 * an unrelated write (e.g. `retries`, `numCtx`) or a no-op write of the same
 * value, or an unrelated `/set` would falsely outrank a real divergence in
 * the newest-wins comparison.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigManager } from "../../../../packages/server/src/config/index.js";
import { initializeCipher } from "@atlasagents/shared";

describe("ConfigManager configChangedAt stamping", () => {
  beforeAll(() => {
    initializeCipher("test-passphrase-for-configchangedat-tests");
  });

  const tempRoots: string[] = [];

  const makeManager = async (): Promise<ConfigManager> => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "atlas-config-changed-at-"),
    );
    tempRoots.push(root);
    return new ConfigManager({ rootDir: root });
  };

  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("defaults to 0 on a fresh config (boundary)", async () => {
    const manager = await makeManager();
    const config = await manager.getAll();
    expect(config.configChangedAt).toBe(0);
  });

  it("stamps a real move forward on setRoleModel (normal)", async () => {
    const manager = await makeManager();
    const before = (await manager.getAll()).configChangedAt;
    await manager.setRoleModel("agent", "ollama", "llama3");
    const after = (await manager.getAll()).configChangedAt;
    expect(after).toBeGreaterThan(before);
  });

  it("does not stamp when setRoleModel writes the same model and provider again (normal — no-op guard)", async () => {
    const manager = await makeManager();
    await manager.setRoleModel("agent", "ollama", "llama3");
    const afterFirst = (await manager.getAll()).configChangedAt;
    await manager.setRoleModel("agent", "ollama", "llama3");
    const afterSecond = (await manager.getAll()).configChangedAt;
    expect(afterSecond).toBe(afterFirst);
  });

  it("stamps on setProvider only when the provider actually changes (normal)", async () => {
    const manager = await makeManager();
    const before = (await manager.getAll()).configChangedAt;
    await manager.setProvider("agent", "ollama"); // "ollama" is already the default — no-op
    expect((await manager.getAll()).configChangedAt).toBe(before);
  });

  it("stamps on set() for agentTemp/subagentTemp (normal)", async () => {
    const manager = await makeManager();
    const before = (await manager.getAll()).configChangedAt;
    await manager.set("agentTemp", 0.5);
    expect((await manager.getAll()).configChangedAt).toBeGreaterThan(before);
  });

  it("does not stamp on set() for an untracked key like retries (normal — the false-outrank guard)", async () => {
    const manager = await makeManager();
    await manager.setRoleModel("agent", "ollama", "llama3");
    const afterModel = (await manager.getAll()).configChangedAt;
    await manager.set("retries", 5);
    expect((await manager.getAll()).configChangedAt).toBe(afterModel);
  });

  it("applySyncedConfig stamps exactly the caller-supplied timestamp, not Date.now() (normal — convergence)", async () => {
    const manager = await makeManager();
    const explicitTimestamp = 123456789;
    await manager.applySyncedConfig(
      {
        agentModel: "synced-agent-model",
        subagentModel: "synced-subagent-model",
        agentProvider: "ollama",
        subagentProvider: "ollama",
        agentTemp: 0.2,
        subagentTemp: 0.6,
      },
      explicitTimestamp,
    );
    const config = await manager.getAll();
    expect(config.configChangedAt).toBe(explicitTimestamp);
    expect(config.agentModel).toBe("synced-agent-model");
    expect(config.subagentModel).toBe("synced-subagent-model");
    expect(config.agentTemp).toBe(0.2);
    expect(config.subagentTemp).toBe(0.6);
  });
});
