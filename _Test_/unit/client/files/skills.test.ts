/**
 * Unit tests — skill name validation (path traversal guard).
 *
 * @remarks
 * `assertSafeSkillName` is tested directly as a pure function rather than
 * through `addSkill`/`readSkill`, since those touch the real
 * `~/.atlasagents/skills` directory (SKILLS_DIR is derived from `os.homedir()`
 * with no test-time override) — exercising them here would read/write the
 * developer's actual home directory as a side effect of running the suite.
 */

import { describe, expect, it } from "vitest";
import { assertSafeSkillName } from "../../../../packages/client/src/skills/skills.js";

describe("assertSafeSkillName — rejects unsafe names", () => {
  it.each([
    [""],
    ["   "],
    ["../evil"],
    ["..\\evil"],
    ["a/b"],
    ["a\\b"],
    [".."],
    ["a/../../etc/passwd"],
    ["/etc/passwd"],
  ])("throws for %j", (name) => {
    expect(() => assertSafeSkillName(name)).toThrow();
  });
});

describe("assertSafeSkillName — accepts ordinary names", () => {
  it.each([["coding"], ["my-skill"], ["skill_2"], ["Testing123"]])(
    "does not throw for %j",
    (name) => {
      expect(() => assertSafeSkillName(name)).not.toThrow();
    },
  );

  it("allows a '..' substring that is not its own path segment", () => {
    // A literal ".." inside a filename (not a traversal segment) is fine —
    // only a full "/../ "-delimited segment is rejected.
    expect(() => assertSafeSkillName("a..b")).not.toThrow();
  });
});
