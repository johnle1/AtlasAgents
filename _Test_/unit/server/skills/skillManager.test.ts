/**
 * Unit tests — server skills/manager/skillManager.ts
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SkillManager } from "../../../../packages/server/src/skills/skillManager.js";

// `readdir` can't be spied on directly (the ESM namespace object's exports
// are non-configurable), so it's routed through a mutable indirection that
// one test can override to pin an otherwise-unpredictable fs race — every
// other call in this file, and the default here, just delegates to the real
// implementation.
const { readdirOverride } = vi.hoisted(() => ({
  readdirOverride: {
    current: null as ((dir: string) => Promise<string[]>) | null,
  },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (dir: string, options?: unknown) =>
      readdirOverride.current
        ? readdirOverride.current(dir)
        : actual.readdir(dir, options as never)) as typeof actual.readdir,
  };
});

const tempRoots: string[] = [];

const makeManager = async (): Promise<{
  manager: SkillManager;
  root: string;
  skillsDir: string;
}> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-skills-"));
  tempRoots.push(root);
  const manager = new SkillManager({ rootDir: root });
  const skillsDir = path.join(root, "user-data", "skills");
  await fs.mkdir(skillsDir, { recursive: true });
  return { manager, root, skillsDir };
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("SkillManager.delete", () => {
  it("removes sanitized markdown and matching meta sidecar", async () => {
    const { manager, skillsDir } = await makeManager();
    const unsafeName = "foo/bar";
    await fs.writeFile(path.join(skillsDir, "foobar.md"), "# skill\n");
    await fs.writeFile(path.join(skillsDir, "foobar.meta.json"), "{}");

    const deleted = await manager.delete(unsafeName);
    expect(deleted).toBe(true);

    await expect(fs.access(path.join(skillsDir, "foobar.md"))).rejects.toThrow();
    await expect(
      fs.access(path.join(skillsDir, "foobar.meta.json")),
    ).rejects.toThrow();
  });

  it("removes skill with Windows-invalid characters in name", async () => {
    const { manager, skillsDir } = await makeManager();
    await fs.writeFile(path.join(skillsDir, "badname.md"), "# skill\n");

    const deleted = await manager.delete("bad<>name");
    expect(deleted).toBe(true);
    await expect(fs.access(path.join(skillsDir, "badname.md"))).rejects.toThrow();
  });
});

describe("SkillManager.selectForTask", () => {
  it("returns empty array when no skills exist", async () => {
    const { manager } = await makeManager();
    const result = await manager.selectForTask("build a web app");
    expect(result).toEqual([]);
  });

  it("returns matching skills for task keywords", async () => {
    const { manager, skillsDir } = await makeManager();
    await fs.writeFile(
      path.join(skillsDir, "coding.md"),
      `# Coding skill\nGeneral programming guidance.\n`,
    );
    await fs.writeFile(
      path.join(skillsDir, "testing.md"),
      `# Testing skill
\`\`\`json skill-meta
{"keywords": ["jest", "testing", "unit"], "domain": true, "stacks": [], "priority": 1}
\`\`\`
Write unit tests with Jest.
`,
    );

    const result = await manager.selectForTask(
      "write unit tests with jest for the api",
    );
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((s) => s.name === "coding")).toBe(true);
    expect(result.some((s) => s.name === "testing")).toBe(true);
  });

  it("falls back to coding skill when task has no keyword overlap", async () => {
    const { manager, skillsDir } = await makeManager();
    await fs.writeFile(
      path.join(skillsDir, "coding.md"),
      `# Coding\nGeneral coding help.\n`,
    );
    await fs.writeFile(
      path.join(skillsDir, "obscure.md"),
      `# Obscure
\`\`\`json skill-meta
{"keywords": ["quantum"], "domain": true, "stacks": [], "priority": 1}
\`\`\`
Quantum computing only.
`,
    );

    const result = await manager.selectForTask("do something unrelated");
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("coding");
  });

  it("ranks a skill matching on a rare keyword above one matching on a keyword common to every skill", async () => {
    const { manager, skillsDir } = await makeManager();
    // "shared" appears in every skill's keywords (df = 3, low IDF weight).
    // "graphql" appears only in graphql.md (df = 1, high IDF weight).
    await fs.writeFile(
      path.join(skillsDir, "coding.md"),
      `# Coding
\`\`\`json skill-meta
{"keywords": ["shared"], "domain": false, "stacks": [], "priority": 0}
\`\`\`
General guidance.
`,
    );
    await fs.writeFile(
      path.join(skillsDir, "testing.md"),
      `# Testing
\`\`\`json skill-meta
{"keywords": ["shared"], "domain": false, "stacks": [], "priority": 0}
\`\`\`
Testing guidance.
`,
    );
    await fs.writeFile(
      path.join(skillsDir, "graphql.md"),
      `# GraphQL
\`\`\`json skill-meta
{"keywords": ["shared", "graphql"], "domain": true, "stacks": [], "priority": 0}
\`\`\`
GraphQL schema guidance.
`,
    );

    const result = await manager.selectForTask("shared graphql work");
    // graphql.md matches both a common keyword (low weight) and a rare one
    // (high weight) — it should win the domain slot over coding/testing,
    // which only match the common keyword.
    expect(result.some((s) => s.name === "graphql")).toBe(true);
  });

  it("rebuilds the relevance index after saveAll adds a new skill", async () => {
    const { manager, skillsDir } = await makeManager();
    await fs.writeFile(path.join(skillsDir, "coding.md"), "# Coding\nGeneral guidance.\n");

    const before = await manager.selectForTask("rust ownership borrowing");
    expect(before.some((s) => s.name === "rust")).toBe(false);

    await manager.saveAll([
      {
        name: "rust",
        content: `# Rust
\`\`\`json skill-meta
{"keywords": ["ownership", "borrowing"], "domain": true, "stacks": ["rust"], "priority": 1}
\`\`\`
Rust ownership and borrowing guidance.
`,
      },
    ]);

    const after = await manager.selectForTask("rust ownership borrowing");
    expect(after.some((s) => s.name === "rust")).toBe(true);
  });

  it("rebuilds the relevance index after delete removes a skill", async () => {
    const { manager, skillsDir } = await makeManager();
    await fs.writeFile(path.join(skillsDir, "coding.md"), "# Coding\nGeneral guidance.\n");
    await fs.writeFile(
      path.join(skillsDir, "rust.md"),
      `# Rust
\`\`\`json skill-meta
{"keywords": ["ownership"], "domain": true, "stacks": ["rust"], "priority": 1}
\`\`\`
Rust ownership guidance.
`,
    );

    expect((await manager.selectForTask("rust ownership")).some((s) => s.name === "rust")).toBe(true);

    await manager.delete("rust");

    expect((await manager.selectForTask("rust ownership")).some((s) => s.name === "rust")).toBe(false);
  });

  it("prefers the stack-mapped skill (by priority) when detectedStack is provided", async () => {
    const { manager, skillsDir } = await makeManager();
    await fs.writeFile(path.join(skillsDir, "coding.md"), "# Coding\nGeneral guidance.\n");
    await fs.writeFile(
      path.join(skillsDir, "python-basic.md"),
      `# Python basic
\`\`\`json skill-meta
{"keywords": [], "domain": false, "stacks": ["python"], "priority": 1}
\`\`\`
Basic Python guidance.
`,
    );
    await fs.writeFile(
      path.join(skillsDir, "python-advanced.md"),
      `# Python advanced
\`\`\`json skill-meta
{"keywords": [], "domain": false, "stacks": ["python"], "priority": 5}
\`\`\`
Advanced Python guidance.
`,
    );

    const result = await manager.selectForTask("write some code", { detectedStack: "python" });
    // Higher priority (5 > 1) wins the stack-to-skill mapping.
    expect(result[0]?.name).toBe("python-advanced");
  });
});

describe("SkillManager.loadAll (loadSkillsFromDir)", () => {
  it("loads skill bodies and metadata from disk via loadSkillsFromDir", async () => {
    const { manager, skillsDir } = await makeManager();
    await fs.writeFile(
      path.join(skillsDir, "alpha.md"),
      "# Alpha\nSkill body for alpha.\n",
    );
    await fs.writeFile(
      path.join(skillsDir, "beta.md"),
      `# Beta
\`\`\`json skill-meta
{"keywords": ["beta"], "domain": false, "stacks": [], "priority": 0}
\`\`\`
Beta body.
`,
    );

    const loaded = await manager.loadAll();
    expect(loaded.get("alpha")).toContain("Skill body for alpha");
    expect(loaded.get("beta")).toContain("Beta body");
    expect(loaded.size).toBe(2);
  });
});

describe("SkillManager.saveAll — index invalidation on partial failure (regression guard)", () => {
  it("still invalidates the index when saveAll throws partway through, so selectForTask doesn't keep serving pre-sync data", async () => {
    // Both Promise.all batches inside saveAll (the writes, then the cleanup
    // deletions) reject on the first failure without undoing what already
    // succeeded elsewhere. If either one throws, saveAll used to never
    // reach its unconditional invalidateIndex() call at the end — leaving
    // selectForTask serving whatever was cached before this call
    // indefinitely, even though disk had already changed underneath it.
    //
    // Named "alpha" rather than "coding" deliberately: selectForTask has a
    // special-cased "coding" fallback for the primary slot, which would
    // mask the very thing under test here (index staleness) behind
    // unrelated scoring rules.
    const { manager, skillsDir } = await makeManager();
    await fs.writeFile(path.join(skillsDir, "alpha.md"), "# Alpha\nAlpha guidance about widgets.\n");

    // Warm the index cache on the pre-sync skill set.
    const before = await manager.selectForTask("beta gizmo particulars");
    expect(before.some((s) => s.name === "beta")).toBe(false);

    // The write batch succeeds (beta.md lands on disk); only the cleanup
    // step's readdir is made to fail, so saveAll rejects AFTER disk has
    // already changed. Because cleanup never runs, alpha.md — which a full
    // sync would have removed — stays on disk too; that's fine, it isn't
    // what this test is checking.
    readdirOverride.current = async () => {
      throw new Error("simulated cleanup failure");
    };

    await expect(
      manager.saveAll([
        { name: "beta", content: "# Beta\nBeta guidance about gizmo particulars.\n" },
      ]),
    ).rejects.toThrow("simulated cleanup failure");

    readdirOverride.current = null;

    // A stale (un-invalidated) index would still only know about "alpha"
    // and return it as the sole fallback match. A correctly-invalidated one
    // rebuilds from disk, finds "beta" too, and scores it far higher
    // against a task that quotes its own wording almost verbatim.
    const after = await manager.selectForTask("beta gizmo particulars");
    expect(after.some((s) => s.name === "beta")).toBe(true);
  });
});

describe("SkillManager.deleteMetaFile (via saveAll sync)", () => {
  it("removes meta sidecar when a skill is dropped from saveAll", async () => {
    const { manager, skillsDir } = await makeManager();
    await fs.writeFile(path.join(skillsDir, "keep.md"), "# keep\n");
    await fs.writeFile(path.join(skillsDir, "drop.md"), "# drop\n");
    await fs.writeFile(path.join(skillsDir, "drop.meta.json"), "{}");

    await manager.saveAll([{ name: "keep", content: "# keep\n" }]);

    await expect(fs.access(path.join(skillsDir, "drop.md"))).rejects.toThrow();
    await expect(
      fs.access(path.join(skillsDir, "drop.meta.json")),
    ).rejects.toThrow();
    await expect(fs.access(path.join(skillsDir, "keep.md"))).resolves.toBeUndefined();
  });
});

describe("SkillManager index build failure recovery", () => {
  it("retries after a transient (non-ENOENT) directory read failure instead of caching the rejection forever (error)", async () => {
    // loadSkillsFromDir only treats ENOENT as "missing dir" and rethrows
    // anything else. Replacing the skills directory with a plain file makes
    // fs.readdir() fail with a real ENOTDIR, mirroring an EACCES/EMFILE the
    // caller can't control.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-skills-"));
    tempRoots.push(root);
    const skillsDir = path.join(root, "user-data", "skills");
    await fs.mkdir(path.dirname(skillsDir), { recursive: true });
    await fs.writeFile(skillsDir, "not a directory");

    const manager = new SkillManager({ rootDir: root });
    await expect(manager.selectForTask("anything")).rejects.toThrow();

    // Clear the transient condition and give the manager a real skill.
    await fs.unlink(skillsDir);
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, "coding.md"), "# Coding\nGeneral guidance.\n");

    // Before the fix, ensureIndexLoaded() cached the rejected build promise
    // forever, so every later selectForTask() kept throwing the same stale
    // error even once the directory was readable again.
    const result = await manager.selectForTask("anything");
    expect(result.some((s) => s.name === "coding")).toBe(true);
  });

  it("does not let a build already in flight revert a concurrent invalidate() (regression guard)", async () => {
    // selectForTask() starts a build; a concurrent saveAll()/delete() that
    // finishes first calls invalidateIndex(). The build in flight used to
    // resolve afterward and unconditionally overwrite the cache with the
    // stale pre-invalidation index, silently undoing the invalidation with
    // nothing left to clear it a second time.
    //
    // Real fs I/O doesn't guarantee that ordering (saveAll's writes might
    // finish before or after the read's single readdir), so this pins it
    // deterministically: readdir() is held open across the invalidate(),
    // and only released once we know invalidateIndex() has already run.
    const { manager, skillsDir } = await makeManager();
    await fs.writeFile(path.join(skillsDir, "coding.md"), "# Coding\nGeneral guidance.\n");

    let releaseFirstReaddir!: () => void;
    const firstReaddirStarted = new Promise<void>((resolveStarted) => {
      readdirOverride.current = async (dir) => {
        readdirOverride.current = null; // one-shot: only the first call is held
        resolveStarted();
        await new Promise<void>((resolve) => (releaseFirstReaddir = resolve));
        return fs.readdir(dir) as Promise<string[]>;
      };
    });

    const staleRead = manager.selectForTask("rust ownership borrowing");
    await firstReaddirStarted; // the build's readdir is now in flight and held open

    await manager.saveAll([
      {
        name: "rust",
        content: `# Rust
\`\`\`json skill-meta
{"keywords": ["ownership", "borrowing"], "domain": true, "stacks": ["rust"], "priority": 1}
\`\`\`
Rust ownership and borrowing guidance.
`,
      },
    ]);
    // saveAll() has now called invalidateIndex() — only now let the stale
    // build's readdir resolve, so it finishes strictly after invalidation.
    releaseFirstReaddir();

    await staleRead;

    // A build resolving after invalidate() must not overwrite the fresh
    // index the sync just built — the next call has to see the new skill.
    const after = await manager.selectForTask("rust ownership borrowing");
    expect(after.some((s) => s.name === "rust")).toBe(true);
  });
});
