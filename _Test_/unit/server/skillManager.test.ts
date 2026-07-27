/**
 * Unit tests — server skills/manager/skillManager.ts
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SkillManager } from "../../../packages/server/src/skills/skillManager.js";

const tempRoots: string[] = [];

const makeManager = async (): Promise<{
  manager: SkillManager;
  root: string;
  skillsDir: string;
}> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-skills-"));
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
});
