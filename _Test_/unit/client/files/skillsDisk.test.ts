/**
 * Unit tests — skills/skills.ts disk helpers with isolated HOME.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTempHome, type TempHome } from "../../../helpers/tempHome.js";

describe("skills disk helpers", () => {
  let listSkills: typeof import("../../../../packages/client/src/skills/skills.js").listSkills;
  let readAllSkills: typeof import("../../../../packages/client/src/skills/skills.js").readAllSkills;
  let readSkillsFromDir: typeof import("../../../../packages/client/src/skills/skills.js").readSkillsFromDir;
  let ensureSkillsDir: typeof import("../../../../packages/client/src/skills/skills.js").ensureSkillsDir;
  let installDefaultSkills: typeof import("../../../../packages/client/src/skills/skills.js").installDefaultSkills;
  let SkillManager: typeof import("../../../../packages/client/src/skills/skills.js").SkillManager;
  let tempHome: TempHome;
  let skillsDir: string;

  beforeAll(async () => {
    tempHome = createTempHome("atlas-skills-test-");
    skillsDir = path.join(tempHome.dir, ".atlasagents", "skills");

    const mod = await import("../../../../packages/client/src/skills/skills.js");
    listSkills = mod.listSkills;
    readAllSkills = mod.readAllSkills;
    readSkillsFromDir = mod.readSkillsFromDir;
    ensureSkillsDir = mod.ensureSkillsDir;
    installDefaultSkills = mod.installDefaultSkills;
    SkillManager = mod.SkillManager;
  });

  afterAll(() => {
    tempHome.restore();
  });

  it("ensureSkillsDir creates the skills directory", () => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    ensureSkillsDir();
    expect(fs.existsSync(skillsDir)).toBe(true);
  });

  it("listSkills and readAllSkills read markdown files", () => {
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "coding.md"), "# coding\n");
    expect(listSkills()).toContain("coding");
    const all = readAllSkills();
    expect(all).toEqual([{ name: "coding", content: "# coding\n" }]);
  });

  it("readSkillsFromDir reads an arbitrary directory", () => {
    const custom = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-custom-skills-"));
    try {
      fs.writeFileSync(path.join(custom, "a.md"), "body");
      expect(readSkillsFromDir(custom)).toEqual([
        { name: "a", content: "body" },
      ]);
    } finally {
      fs.rmSync(custom, { recursive: true, force: true });
    }
  });

  it("installDefaultSkills is a no-op when skills dir already exists", () => {
    fs.mkdirSync(skillsDir, { recursive: true });
    const before = fs.readdirSync(skillsDir);
    installDefaultSkills();
    expect(fs.readdirSync(skillsDir)).toEqual(before);
  });

  it("SkillManager.sync uploads via connection", async () => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "sync-me.md"), "# sync\n");
    const syncSkills = vi.fn(async () => {});
    const manager = new SkillManager({ syncSkills } as never);
    const count = await manager.sync();
    expect(count).toBe(1);
    expect(syncSkills).toHaveBeenCalledWith([
      { name: "sync-me", content: "# sync\n" },
    ]);
  });
});
