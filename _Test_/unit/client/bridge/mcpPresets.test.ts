/**
 * Unit tests — client mcp/mcpPresets.ts (structural integrity of the
 * built-in preset table, not the third-party endpoints themselves).
 */

import { describe, expect, it } from "vitest";
import {
  isMcpPresetId,
  MCP_PRESET_IDS,
  MCP_PRESETS,
} from "../../../../packages/client/src/mcp/mcpPresets.js";
import { validateServerId } from "../../../../packages/client/src/mcp/mcpServerName.js";

describe("MCP_PRESETS", () => {
  it("includes github, jira, and slack", () => {
    expect(Object.keys(MCP_PRESETS).sort()).toEqual(["github", "jira", "slack"]);
  });

  it("every preset's id matches its own key", () => {
    for (const [key, preset] of Object.entries(MCP_PRESETS)) {
      expect(preset.id).toBe(key);
    }
  });

  it("every preset has a non-empty label and a valid transport shape", () => {
    for (const preset of Object.values(MCP_PRESETS)) {
      expect(preset.label.length).toBeGreaterThan(0);
      if (preset.config.transport === "stdio") {
        expect(preset.config.command.length).toBeGreaterThan(0);
      } else {
        expect(() => new URL(preset.config.url)).not.toThrow();
      }
    }
  });

  it("every secret field has a key and a non-empty prompt", () => {
    for (const preset of Object.values(MCP_PRESETS)) {
      for (const field of preset.secretFields) {
        expect(field.key.length).toBeGreaterThan(0);
        expect(field.prompt.length).toBeGreaterThan(0);
      }
    }
  });

  it("every preset id passes validateServerId (normal)", () => {
    for (const id of Object.keys(MCP_PRESETS)) {
      expect(validateServerId(id)).toEqual({ ok: true });
    }
  });

  it("the jira preset points at the current v2 Atlassian endpoint (normal — regression guard)", () => {
    const jira = MCP_PRESETS.jira!;
    expect(jira.config.transport).toBe("stdio");
    if (jira.config.transport === "stdio") {
      expect(jira.config.args).toContain("https://mcp.atlassian.com/v2/mcp");
    }
  });

  it("no preset references a stale /v1/ Atlassian endpoint (error — the exact bug being fixed)", () => {
    for (const preset of Object.values(MCP_PRESETS)) {
      const endpoint =
        preset.config.transport === "stdio"
          ? (preset.config.args ?? []).join(" ")
          : preset.config.url;
      expect(endpoint).not.toMatch(/mcp\.atlassian\.com\/v1\//);
    }
  });
});

describe("isMcpPresetId / MCP_PRESET_IDS", () => {
  it("recognizes a real preset id", () => {
    expect(isMcpPresetId("github")).toBe(true);
  });

  it("rejects an unknown id", () => {
    expect(isMcpPresetId("not-a-real-preset")).toBe(false);
  });

  it("lists every preset key", () => {
    expect([...MCP_PRESET_IDS].sort()).toEqual(["github", "jira", "slack"]);
  });
});
