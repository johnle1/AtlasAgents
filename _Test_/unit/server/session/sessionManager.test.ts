/**
 * Unit tests — memory/session/sessionManager.ts
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../../../../packages/server/src/memory/session/sessionManager.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("SessionManager", () => {
  it("reads empty string when no session file exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-session-"));
    tempRoots.push(root);
    const session = new SessionManager({ rootDir: root });
    await expect(session.read()).resolves.toBe("");
    await expect(session.exists()).resolves.toBe(false);
  });

  it("saveSnapshot, append, and clear round-trip", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-session-"));
    tempRoots.push(root);
    const session = new SessionManager({ rootDir: root });

    await session.saveSnapshot("Structure:\n./src\n");
    const afterSnapshot = await session.read();
    expect(afterSnapshot).toContain("Codebase snapshot");
    expect(afterSnapshot).toContain("./src");

    await session.append({
      task: "Fix bug",
      filesWritten: ["src/a.ts"],
      commandsRun: ["npm test"],
      outcome: "success",
    });
    const afterAppend = await session.read();
    expect(afterAppend).toContain('Task 1 — "Fix bug"');
    expect(afterAppend).toContain("src/a.ts");

    await expect(session.clear()).resolves.toBe("Session cleared");
    await expect(session.exists()).resolves.toBe(false);
  });
});
