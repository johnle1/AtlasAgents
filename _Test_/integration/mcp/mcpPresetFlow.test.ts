/**
 * Integration tests — `/mcp add <preset>` for EVERY built-in preset,
 * table-driven over `MCP_PRESETS`, through the real disk-backed encrypted
 * config and the real local per-server tool cache.
 *
 * @remarks
 * Before this file, preset integration coverage tracked which preset had
 * had a bug, not which needed testing: `mcpJiraPreset.test.ts` existed
 * because jira's endpoint went stale; `github` and `slack` had no
 * preset-specific integration coverage at all (`github` appeared only as
 * an arbitrary fixture server name pointing at a made-up URL, and `slack` —
 * the only preset with two `secretFields` — had none). Iterating
 * `MCP_PRESETS` here means a fourth preset gets this coverage the day it's
 * added, not the day it breaks.
 *
 * `mcpJiraPreset.test.ts` still owns what's genuinely jira-specific (the
 * `/v2/` endpoint regression guard, the mcp-remote-owns-OAuth rationale,
 * the API-token direct-URL alternative) — this file only covers what's
 * true of every preset uniformly.
 *
 * `GOLDEN_PRESETS` below is deliberately hand-maintained rather than
 * derived from `MCP_PRESETS` itself: a test that builds both its input
 * AND its expectation from the same live table can never fail, even if a
 * field is silently deleted from that table (verified in-session: with
 * `SLACK_TEAM_ID` removed from the slack preset, a first draft of this
 * file that compared `preset.secretFields` against itself stayed green).
 * Comparing the live table against an independent golden copy is what
 * makes these actual regression guards. A preset with no golden entry
 * fails the "every preset has a golden fixture" check below by design —
 * adding a fifth preset means adding its golden entry here too.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : handleMcp (commands/mcpHandlers.ts), the real
 *                          preset table (mcp/mcpPresets.ts), the real
 *                          encrypted client config (temp HOME), the real
 *                          local MCP tool cache, and mcpRegistry.ts's
 *                          discovery/registry logic.
 * Mocks                  : `@modelcontextprotocol/sdk/client/*` (no real
 *   spawn/socket — a fake server returns one fixed stub tool), and
 *   `conn.sendCommand` (captures the outgoing sync payload).
 *
 * Category checklist:
 *   ✅ Normal   — every preset's live config/secretFields match their
 *                 golden fixture; `/mcp add` writes that config verbatim;
 *                 prompts for every secretFields entry, in declared order,
 *                 with the declared mask, storing each answer under its
 *                 declared key; discovers tools namespaced mcp__<id>__*;
 *                 no prompted secret lands in the on-disk config in plaintext
 *   ✅ Boundary — a preset with zero secretFields (jira) prompts for
 *                 nothing but still writes an empty mcpSecrets entry
 *   ✅ Error    — (not applicable per-preset here — see mcpAddFlow.test.ts
 *                 for the generic invalid-input error path shared by every
 *                 `/mcp add` shape)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempHome, type TempHome } from "../../helpers/tempHome.js";
import { MCP_PRESETS } from "../../../packages/client/src/mcp/mcpPresets.js";
import type { McpServerConfig } from "../../../packages/client/src/config/types.js";

/** One preset's expected shape, independent of `mcp/mcpPresets.ts` — see the file-level remarks. */
type GoldenPreset = {
  config: McpServerConfig;
  secretFields: Array<{ key: string; promptContains: string; mask?: boolean }>;
};

const GOLDEN_PRESETS: Record<string, GoldenPreset> = {
  github: {
    config: { transport: "http", url: "https://api.githubcopilot.com/mcp/" },
    secretFields: [{ key: "token", promptContains: "personal access token", mask: true }],
  },
  jira: {
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "mcp-remote", "https://mcp.atlassian.com/v2/mcp"],
    },
    secretFields: [],
  },
  slack: {
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
    },
    secretFields: [
      { key: "SLACK_BOT_TOKEN", promptContains: "Slack bot token", mask: true },
      { key: "SLACK_TEAM_ID", promptContains: "Slack team/workspace ID" },
    ],
  },
};

const { connectMock, listToolsMock, closeMock } = vi.hoisted(() => ({
  connectMock: vi.fn().mockResolvedValue(undefined),
  listToolsMock: vi.fn().mockResolvedValue({ tools: [] }),
  closeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = connectMock;
    listTools = listToolsMock;
    callTool = vi.fn();
    close = closeMock;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(),
}));

describe("integration — /mcp add <preset>, every preset in MCP_PRESETS", () => {
  it("every preset in MCP_PRESETS has a golden fixture above, and vice versa (normal)", () => {
    expect(Object.keys(MCP_PRESETS).sort()).toEqual(Object.keys(GOLDEN_PRESETS).sort());
  });

  let tempHome: TempHome;
  let configFile: string;
  let cacheDir: string;

  let handleMcp: typeof import("../../../packages/client/src/commands/mcpHandlers.js").handleMcp;
  let loadConfig: typeof import("../../../packages/client/src/config/index.js").loadConfig;
  let unlockOrSetupConfigCipher: typeof import("../../../packages/client/src/config/index.js").unlockOrSetupConfigCipher;
  let lockCipher: typeof import("@atlasagents/shared").lockCipher;
  let getToolMetadata: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").getToolMetadata;
  let resetToolRegistryForTests: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").resetToolRegistryForTests;
  let disconnectAllMcpClients: typeof import("../../../packages/client/src/mcp/mcpRegistry.js").disconnectAllMcpClients;

  beforeAll(async () => {
    tempHome = createTempHome("atlas-mcp-preset-flow-");
    configFile = path.join(tempHome.dir, ".atlasagents", "config.json");
    cacheDir = path.join(tempHome.dir, ".atlasagents", "mcpToolsCache");

    const configMod = await import("../../../packages/client/src/config/index.js");
    loadConfig = configMod.loadConfig;
    unlockOrSetupConfigCipher = configMod.unlockOrSetupConfigCipher;

    const cipherMod = await import("@atlasagents/shared");
    lockCipher = cipherMod.lockCipher;

    const handlersMod = await import("../../../packages/client/src/commands/mcpHandlers.js");
    handleMcp = handlersMod.handleMcp;

    const registryMod = await import("../../../packages/client/src/mcp/mcpRegistry.js");
    getToolMetadata = registryMod.getToolMetadata;
    resetToolRegistryForTests = registryMod.resetToolRegistryForTests;
    disconnectAllMcpClients = registryMod.disconnectAllMcpClients;
  });

  afterAll(() => {
    tempHome.restore();
  });

  beforeEach(async () => {
    await unlockOrSetupConfigCipher(async () => "integration-test-pass");
    resetToolRegistryForTests();
    connectMock.mockClear().mockResolvedValue(undefined);
    listToolsMock.mockReset().mockResolvedValue({
      tools: [
        {
          name: "stub_tool",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    closeMock.mockClear().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await disconnectAllMcpClients();
    lockCipher();
    fs.rmSync(configFile, { force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const fakeConn = { sendCommand: vi.fn(async () => ({})) } as never;
  const fakeFileProxy = { getWorkspaceRoot: () => tempHome!.dir } as never;
  const makePrompts = (answers: string[] = []) => {
    let i = 0;
    const question = vi.fn(async () => answers[i++] ?? "");
    return {
      prompts: { question, choose: vi.fn(), pickTheme: vi.fn(), pickOption: vi.fn() } as never,
      question,
    };
  };

  for (const [id, preset] of Object.entries(MCP_PRESETS)) {
    const golden = GOLDEN_PRESETS[id];

    describe(`preset "${id}" (${preset.label})`, () => {
      if (!golden) {
        // Caught by the top-level "every preset has a golden fixture"
        // check above; skip the shape-dependent tests below rather than
        // throwing here and hiding that clearer failure.
        it.skip("no golden fixture for this preset — see the top-level check", () => {});
        return;
      }

      it("matches its golden connection shape (normal — a config-value regression guard)", () => {
        expect(preset.config).toEqual(golden.config);
      });

      it("matches its golden secretFields shape: same keys, order, and mask flags (normal)", () => {
        expect(preset.secretFields.map((f) => ({ key: f.key, mask: f.mask }))).toEqual(
          golden.secretFields.map((f) => ({ key: f.key, mask: f.mask })),
        );
        preset.secretFields.forEach((field, i) => {
          expect(field.prompt).toContain(golden.secretFields[i]!.promptContains);
        });
      });

      it("writes the golden connection shape verbatim via /mcp add (normal)", async () => {
        const answers = golden.secretFields.map((_, i) => `answer-${i}`);
        const { prompts } = makePrompts(answers);
        await handleMcp("add", id, fakeConn, fakeFileProxy, prompts);

        expect(loadConfig().mcpServers[id]).toEqual(golden.config);
      });

      it(
        golden.secretFields.length > 0
          ? `prompts for all ${golden.secretFields.length} secretFields entries, in order, correctly masked (normal)`
          : "prompts for nothing — this preset declares zero secretFields (boundary)",
        async () => {
          const answers = golden.secretFields.map((_, i) => `answer-${i}`);
          const { prompts, question } = makePrompts(answers);
          await handleMcp("add", id, fakeConn, fakeFileProxy, prompts);

          expect(question).toHaveBeenCalledTimes(golden.secretFields.length);
          golden.secretFields.forEach((field, i) => {
            expect(question).toHaveBeenNthCalledWith(
              i + 1,
              expect.stringContaining(field.promptContains),
              { masked: field.mask },
            );
          });

          const expectedSecrets = Object.fromEntries(
            golden.secretFields.map((field, i) => [field.key, answers[i]]),
          );
          expect(loadConfig().mcpSecrets[id]).toEqual(expectedSecrets);
        },
      );

      it("discovers tools and namespaces them mcp__<id>__* in the registry (normal)", async () => {
        const { prompts } = makePrompts(golden.secretFields.map((_, i) => `answer-${i}`));
        await handleMcp("add", id, fakeConn, fakeFileProxy, prompts);

        expect(getToolMetadata(`mcp__${id}__stub_tool`)).toEqual({
          serverId: id,
          toolName: "stub_tool",
          readOnly: true,
        });
      });

      it("never writes a prompted secret value in plaintext to the on-disk config (normal)", async () => {
        if (golden.secretFields.length === 0) {
          return; // nothing is prompted for — nothing to check.
        }
        const answers = golden.secretFields.map((_, i) => `unique-secret-marker-${id}-${i}`);
        const { prompts } = makePrompts(answers);
        await handleMcp("add", id, fakeConn, fakeFileProxy, prompts);

        const raw = fs.readFileSync(configFile, "utf-8");
        for (const answer of answers) {
          expect(raw).not.toContain(answer);
        }
      });
    });
  }
});
