/**
 * Unit tests — client commands/workspaceHandlers.ts
 *
 * `/workspace set` is the sandbox confinement boundary: every file and
 * command path check in the file proxy is scoped to this directory, so
 * these tests focus on the refusal of roots that would defeat that
 * confinement (the filesystem root, or the user's home directory) alongside
 * the normal accept path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  updateConfig: vi.fn(),
}));

import { updateConfig } from "../../../../packages/client/src/config/index.js";
import { handleWorkspace } from "../../../../packages/client/src/commands/workspaceHandlers.js";

describe("handleWorkspace — set", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-workspace-test-"));
    vi.mocked(updateConfig).mockClear();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("accepts a real project subdirectory (normal)", async () => {
    await handleWorkspace("set", testDir, undefined, undefined);
    expect(updateConfig).toHaveBeenCalledWith({ workspace: testDir });
  });

  it("refuses the filesystem root (error — sandbox confinement)", async () => {
    const root = path.parse(testDir).root;
    await handleWorkspace("set", root, undefined, undefined);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("refuses the user's home directory (error — sandbox confinement)", async () => {
    await handleWorkspace("set", os.homedir(), undefined, undefined);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("still refuses a nonexistent directory (existing behavior)", async () => {
    await handleWorkspace(
      "set",
      path.join(testDir, "does-not-exist"),
      undefined,
      undefined,
    );
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
