/**
 * Integration tests — @ mentions against a real LocalFileProxy + temp dir.
 *
 * Real modules wired: LocalFileProxy, expandMentions, Node fs.
 * Mocks: agent-status spinners and config (same as localFileProxy unit tests).
 *
 * Category checklist:
 * - Happy path: @README.md inlines file content
 * - Contract: missing path inlines an error, does not throw
 * - Failure: .env is refused (secret-ish)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../packages/client/src/state/agentStatus.js", () => ({
  startWorking: vi.fn(),
  startThinking: vi.fn(),
  stopAnimated: vi.fn(),
  beginBlockOutput: vi.fn(),
  setTaskActive: vi.fn(),
  isTaskActive: () => false,
}));

vi.mock("../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => ({
    ui: { theme: "default", showSpinner: true },
    server: "localhost",
    port: 7000,
    password: "",
    shellTimeoutMs: 5000,
  }),
}));

import { LocalFileProxy } from "../../../packages/client/src/fileProxy/proxy.js";
import {
  expandMentions,
  resolverFromFileProxy,
} from "../../../packages/client/src/ui/mentions/expand.js";

describe("mentionFlow — LocalFileProxy resolver", () => {
  let root: string;
  let proxy: LocalFileProxy;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mention-"));
    fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n");
    fs.writeFileSync(path.join(root, ".env"), "SECRET=do-not-inline\n");
    proxy = new LocalFileProxy(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("inlines @README.md from the workspace (happy path)", async () => {
    const { text } = await expandMentions(
      "summarize @README.md",
      resolverFromFileProxy(proxy),
    );
    expect(text).toContain("# File: README.md");
    expect(text).toContain("# Fixture");
  });

  it("inlines an error for a missing path without throwing (contract)", async () => {
    const { text } = await expandMentions(
      "open @nope.ts",
      resolverFromFileProxy(proxy),
    );
    expect(text).toMatch(/Could not read @nope\.ts/i);
  });

  it("refuses .env (failure — secret-ish)", async () => {
    const { text } = await expandMentions(
      "dump @.env",
      resolverFromFileProxy(proxy),
    );
    expect(text).toMatch(/Refused to read @\.env/i);
    expect(text).not.toContain("SECRET=do-not-inline");
  });
});
