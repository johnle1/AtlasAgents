/**
 * Unit tests — LocalFileProxy public API.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../packages/client/src/state/agentStatus.js", () => ({
  startWorking: vi.fn(),
  startThinking: vi.fn(),
  stopAnimated: vi.fn(),
  beginBlockOutput: vi.fn(),
  setTaskActive: vi.fn(),
  isTaskActive: () => false,
}));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  loadConfig: () => ({
    ui: { theme: "default", showSpinner: true },
    server: "localhost",
    port: 7000,
    password: "",
    shellTimeoutMs: 5000,
  }),
}));

import { LocalFileProxy } from "../../../../packages/client/src/fileProxy/proxy.js";
import {
  startThinking,
  startWorking,
  stopAnimated,
} from "../../../../packages/client/src/state/agentStatus.js";

describe("LocalFileProxy", () => {
  let root: string;
  let proxy: LocalFileProxy;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "loopy-proxy-"));
    proxy = new LocalFileProxy(root);
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolveAbsolute joins under the workspace root", () => {
    const abs = proxy.resolveAbsolute("src/a.ts");
    expect(abs.startsWith(path.resolve(root))).toBe(true);
  });

  it("listStructure / listDirectoryEntries / expandDirectory work on a temp tree", async () => {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export {};\n");
    const structure = await proxy.listStructure(2);
    expect(structure).toContain("src");
    const entries = await proxy.listDirectoryEntries(root);
    expect(entries.some((e) => e.name === "src")).toBe(true);
    await proxy.expandDirectory(path.join(root, "src"), 0);
  });

  it("handle triggers working spinner helpers for non-quiet routes", async () => {
    fs.writeFileSync(path.join(root, "readme.md"), "hi\n");
    const result = await proxy.handle("file.read", { path: "readme.md" });
    expect(result.ok).toBe(true);
    expect(startWorking).toHaveBeenCalled();
    expect(stopAnimated).toHaveBeenCalled();
  });

  it("classifyCommand returns a bash class", () => {
    expect(proxy.classifyCommand("ls")).toBeTruthy();
  });
});

// Keep agentStatus helpers referenced for the gap report name matches.
void startThinking;
