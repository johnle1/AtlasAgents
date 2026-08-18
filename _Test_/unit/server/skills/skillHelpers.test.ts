/**
 * Unit tests — server skills/skillHelpers.ts
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ValidationError } from "../../../../packages/server/src/errors/index.js";
import {
  ensureDir,
  isFileNotFound,
  listSkillBasenames,
  loadSkillsFromDir,
  normaliseSkillsMap,
  readSidecarMeta,
  readSkillFromDir,
  skillFileName,
} from "../../../../packages/server/src/skills/skillHelpers.js";

const tempRoots: string[] = [];

const makeSkillsDir = (): string => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "atlas-skill-helpers-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("isFileNotFound", () => {
  it("returns true for ENOENT errors", () => {
    expect(isFileNotFound(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(
      true,
    );
  });

  it("returns false for other errors", () => {
    expect(isFileNotFound(new Error("boom"))).toBe(false);
    expect(isFileNotFound({ code: "EACCES" })).toBe(false);
  });
});

describe("ensureDir", () => {
  it("creates nested directories", async () => {
    const root = makeSkillsDir();
    const nested = path.join(root, "a", "b", "c");
    await ensureDir(nested);
    await expect(fs.access(nested)).resolves.toBeUndefined();
  });
});

describe("normaliseSkillsMap", () => {
  it("maps array entries by trimmed name", () => {
    const map = normaliseSkillsMap([
      { name: "  alpha  ", content: "A" },
      { name: "", content: "skip" },
      { name: "beta", content: "B" },
    ]);
    expect(map.size).toBe(2);
    expect(map.get("alpha")).toBe("A");
    expect(map.get("beta")).toBe("B");
  });

  it("maps object entries by trimmed keys", () => {
    const map = normaliseSkillsMap({ " gamma ": "G", "": "skip", delta: "D" });
    expect([...map.entries()]).toEqual([
      ["gamma", "G"],
      ["delta", "D"],
    ]);
  });
});

describe("skillFileName", () => {
  it("sanitizes path segments and ensures .md extension", () => {
    expect(skillFileName("foo/bar")).toBe("foobar.md");
    expect(skillFileName("MySkill.md")).toBe("MySkill.md");
  });

  it("throws ValidationError when name is empty after sanitization", () => {
    expect(() => skillFileName("///")).toThrow(ValidationError);
  });
});

describe("readSidecarMeta", () => {
  it("returns parsed JSON when sidecar exists", async () => {
    const dir = makeSkillsDir();
    await fs.writeFile(
      path.join(dir, "skill.meta.json"),
      JSON.stringify({ keywords: ["jest"] }),
    );
    await expect(readSidecarMeta(dir, "skill")).resolves.toEqual({ keywords: ["jest"] });
  });

  it("returns undefined when sidecar is missing", async () => {
    const dir = makeSkillsDir();
    await expect(readSidecarMeta(dir, "missing")).resolves.toBeUndefined();
  });
});

describe("readSkillFromDir", () => {
  it("loads markdown body and merges sidecar meta", async () => {
    const dir = makeSkillsDir();
    await fs.writeFile(path.join(dir, "coding.md"), "# Coding\nGuidance.\n");
    await fs.writeFile(
      path.join(dir, "coding.meta.json"),
      JSON.stringify({ keywords: ["typescript"], priority: 2 }),
    );

    const skill = await readSkillFromDir(dir, "coding");
    expect(skill).toEqual({
      name: "coding",
      content: "# Coding\nGuidance.\n",
      meta: {
        keywords: ["typescript"],
        domain: false,
        stacks: [],
        priority: 2,
      },
    });
  });

  it("returns null when markdown file is missing", async () => {
    const dir = makeSkillsDir();
    await expect(readSkillFromDir(dir, "ghost")).resolves.toBeNull();
  });
});

describe("loadSkillsFromDir", () => {
  it("loads all .md skills in parallel", async () => {
    const dir = makeSkillsDir();
    await fs.writeFile(path.join(dir, "one.md"), "# One\n");
    await fs.writeFile(path.join(dir, "two.md"), "# Two\n");
    await fs.writeFile(path.join(dir, "two.meta.json"), "{}");
    await fs.writeFile(path.join(dir, "readme.txt"), "ignore");

    const map = await loadSkillsFromDir(dir);
    expect([...map.keys()].sort()).toEqual(["one", "two"]);
    expect(map.get("one")?.content).toContain("# One");
  });

  it("returns empty map when directory does not exist", async () => {
    const dir = path.join(makeSkillsDir(), "no-such-dir");
    await expect(loadSkillsFromDir(dir)).resolves.toEqual(new Map());
  });
});

describe("listSkillBasenames", () => {
  it("lists basenames without reading file contents", async () => {
    const dir = makeSkillsDir();
    await fs.writeFile(path.join(dir, "alpha.md"), "# A\n");
    await fs.writeFile(path.join(dir, "beta.md"), "# B\n");

    const names = await listSkillBasenames(dir);
    expect(names.sort()).toEqual(["alpha", "beta"]);
  });

  it("returns empty array when directory is missing", async () => {
    const dir = path.join(makeSkillsDir(), "missing");
    await expect(listSkillBasenames(dir)).resolves.toEqual([]);
  });
});
