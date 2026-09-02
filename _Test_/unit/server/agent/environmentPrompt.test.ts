/**
 * Unit tests — server orchestration/agent/environmentPrompt.ts
 *
 * @remarks
 * `run_command` executes on the CLIENT's machine (relayed over the file
 * proxy), not the server's — so `buildEnvironmentBlock` is what stops the
 * agent from guessing between `ls` and `dir`. These tests are the direct
 * regression guard for that: one platform, one right answer.
 */

import { describe, expect, it } from "vitest";
import {
  buildEnvironmentBlock,
  buildToolCatalogBlock,
} from "../../../../packages/server/src/orchestration/agent/environmentPrompt.js";
import type { ToolSchema } from "../../../../packages/server/src/orchestration/tools/types.js";

describe("buildEnvironmentBlock", () => {
  it("emits cmd.exe / dir / findstr for win32 with cmd.exe shell", () => {
    const block = buildEnvironmentBlock({
      platform: "win32",
      shell: "cmd.exe",
    });
    expect(block).toContain("Windows");
    expect(block).toContain("cmd.exe");
    expect(block).toContain("dir");
    expect(block).toContain("findstr");
    expect(block).not.toContain("ls -la");
    expect(block).not.toContain("grep -rn");
  });

  it("emits POSIX ls/grep for win32 when execution shell is /bin/sh (container)", () => {
    const block = buildEnvironmentBlock({
      platform: "win32",
      shell: "/bin/sh",
    });
    expect(block).toContain("Windows");
    expect(block).toContain("/bin/sh");
    expect(block).toContain("ls -la");
    expect(block).toContain("grep -rn");
    expect(block).not.toContain("findstr");
  });

  it("emits POSIX ls/grep for darwin", () => {
    const block = buildEnvironmentBlock({ platform: "darwin" });
    expect(block).toContain("macOS");
    expect(block).toContain("/bin/zsh");
    expect(block).toContain("ls -la");
    expect(block).toContain("grep -rn");
    expect(block).not.toContain("cmd.exe");
    expect(block).not.toContain("findstr");
  });

  it("emits POSIX ls/grep for linux", () => {
    const block = buildEnvironmentBlock({ platform: "linux" });
    expect(block).toContain("Linux");
    expect(block).toContain("/bin/bash");
    expect(block).toContain("ls -la");
    expect(block).toContain("grep -rn");
  });

  it("includes git log/show examples on every platform (identical across all three)", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      const block = buildEnvironmentBlock({ platform });
      expect(block).toContain("git log --oneline -5");
      expect(block).toContain("git show <sha>");
    }
  });

  it("falls back to the POSIX/Linux profile when clientEnv is undefined (older client)", () => {
    const block = buildEnvironmentBlock(undefined);
    expect(block).toContain("Linux");
    expect(block).toContain("ls -la");
  });

  it("falls back to the POSIX/Linux profile for an unrecognized platform string", () => {
    const block = buildEnvironmentBlock({ platform: "sunos" });
    expect(block).toContain("Linux");
  });

  it("prefers the client-reported shell over the platform default when given", () => {
    const block = buildEnvironmentBlock({ platform: "darwin", shell: "/bin/fish" });
    expect(block).toContain("/bin/fish");
    expect(block).not.toContain("/bin/zsh");
  });

  it("includes the OS release string when provided", () => {
    const block = buildEnvironmentBlock({
      platform: "darwin",
      osRelease: "Darwin 25.6.0",
    });
    expect(block).toContain("Darwin 25.6.0");
  });
});

describe("buildToolCatalogBlock", () => {
  const schemas: ToolSchema[] = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative path" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tokensave_search",
        description: "Search the codebase",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
  ];

  it("lists every tool in the given registry, including a synced MCP tool", () => {
    const block = buildToolCatalogBlock(schemas);
    expect(block).toContain("read_file");
    expect(block).toContain("run_command");
    expect(block).toContain("tokensave_search");
  });

  it("omits a tool that was not passed in (reflects the live registry, not a hardcoded list)", () => {
    const block = buildToolCatalogBlock(schemas.slice(0, 1));
    expect(block).toContain("read_file");
    expect(block).not.toContain("run_command");
    expect(block).not.toContain("tokensave_search");
  });

  it("renders an empty catalog line rather than throwing for an empty registry", () => {
    expect(() => buildToolCatalogBlock([])).not.toThrow();
  });
});
