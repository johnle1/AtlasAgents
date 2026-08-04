/**
 * Unit tests — server skills/skillMeta.ts
 *
 * Focused on parseSkillDocument's inline-metadata extraction, specifically
 * the fix for INLINE_META_RE requiring the fence to be the literal first
 * byte of the file. Every real skill file (and every fixture in
 * skillManager.test.ts) opens with a `#` title heading before the fence,
 * which the original `^```json` anchor never matched — silently leaving
 * meta.keywords/domain/stacks/priority empty for every realistically
 * authored skill. This was invisible under the old scoring algorithm
 * (which scored a raw, unstripped content preview) but directly blocks
 * IDF-weighted scoring and domain-flag gating, which both depend on
 * correctly parsed metadata.
 *
 * Category checklist:
 * - Normal: heading + fence parses correctly, heading preserved in body
 * - Boundary: no heading (backward compatible), no meta block at all
 * - Normal: sidecar-only and sidecar+inline merge paths (unchanged logic,
 *   re-verified against the new regex)
 */

import { describe, expect, it } from "vitest";
import {
  buildSkillIndex,
  normaliseSkillMeta,
  parseSkillDocument,
  parseSkillMetaJson,
  scoreSkillForTask,
} from "../../../../packages/server/src/skills/skillMeta.js";
import { tokenise } from "../../../../packages/server/src/skills/skillHelpers.js";
import type { LoadedSkill } from "../../../../packages/server/src/skills/types.js";

describe("parseSkillDocument — inline metadata preceded by a heading", () => {
  it("parses the metadata block and preserves the heading in the body", () => {
    const markdown = `# Testing skill
\`\`\`json skill-meta
{"keywords": ["jest", "unit"], "domain": true, "stacks": ["typescript"], "priority": 2}
\`\`\`
Write unit tests with Jest.
`;
    const { body, meta } = parseSkillDocument(markdown);

    expect(meta).toEqual({
      keywords: ["jest", "unit"],
      domain: true,
      stacks: ["typescript"],
      priority: 2,
    });
    expect(body).toContain("# Testing skill");
    expect(body).toContain("Write unit tests with Jest.");
    expect(body).not.toContain("skill-meta");
    expect(body).not.toContain("```");
  });
});

describe("parseSkillDocument — inline metadata with no heading", () => {
  it("still parses correctly when the fence is the literal first line (backward compatible)", () => {
    const markdown = `\`\`\`json skill-meta
{"keywords": ["quantum"], "domain": true, "stacks": [], "priority": 1}
\`\`\`
Quantum computing only.
`;
    const { body, meta } = parseSkillDocument(markdown);
    expect(meta.keywords).toEqual(["quantum"]);
    expect(meta.domain).toBe(true);
    expect(body.trim()).toBe("Quantum computing only.");
  });
});

describe("parseSkillDocument — no metadata block present", () => {
  it("returns empty metadata and the body unchanged", () => {
    const markdown = "# Coding\nGeneral programming guidance.\n";
    const { body, meta } = parseSkillDocument(markdown);
    expect(meta).toEqual({ keywords: [], domain: false, stacks: [], priority: 0 });
    expect(body).toBe(markdown);
  });
});

describe("parseSkillDocument — sidecar metadata", () => {
  it("uses sidecar metadata when there is no inline block", () => {
    const markdown = "# Coding\nGeneral guidance.\n";
    const { meta } = parseSkillDocument(markdown, {
      keywords: ["python"],
      domain: false,
      stacks: ["python"],
      priority: 3,
    });
    expect(meta.keywords).toEqual(["python"]);
    expect(meta.stacks).toEqual(["python"]);
    expect(meta.priority).toBe(3);
  });

  it("merges sidecar and inline metadata: non-empty sidecar.stacks wins, domain/priority combine, keywords union", () => {
    const markdown = `# Coding
\`\`\`json skill-meta
{"keywords": ["typescript"], "domain": false, "stacks": [], "priority": 0}
\`\`\`
Guidance.
`;
    const { meta } = parseSkillDocument(markdown, {
      keywords: ["fallback"],
      domain: true,
      stacks: ["python"],
      priority: 5,
    });

    expect(meta.stacks).toEqual(["python"]); // sidecar's non-empty stacks takes precedence
    expect(meta.domain).toBe(true); // sidecar.domain || inline.domain
    expect(meta.priority).toBe(5); // max(sidecar, inline)
    expect([...meta.keywords].sort()).toEqual(["fallback", "typescript"]); // union, deduped
  });
});

describe("normaliseSkillMeta", () => {
  it("coerces fields and applies defaults for invalid input", () => {
    expect(normaliseSkillMeta(null)).toEqual({
      keywords: [],
      domain: false,
      stacks: [],
      priority: 0,
    });
    expect(
      normaliseSkillMeta({
        keywords: [" Jest ", 42],
        domain: "yes",
        stacks: ["TypeScript", ""],
        priority: 2.9,
      }),
    ).toEqual({
      keywords: ["jest"],
      domain: false,
      stacks: ["typescript"],
      priority: 2,
    });
    expect(normaliseSkillMeta({ domain: true }).domain).toBe(true);
  });
});

describe("parseSkillMetaJson", () => {
  it("returns null for empty or invalid JSON", () => {
    expect(parseSkillMetaJson("   ")).toBeNull();
    expect(parseSkillMetaJson("{not json")).toBeNull();
  });

  it("parses and normalises valid JSON", () => {
    expect(parseSkillMetaJson('{"keywords":["vitest"],"priority":1}')).toEqual({
      keywords: ["vitest"],
      domain: false,
      stacks: [],
      priority: 1,
    });
  });
});

describe("buildSkillIndex and scoreSkillForTask", () => {
  const makeSkill = (
    name: string,
    content: string,
    meta: LoadedSkill["meta"],
  ): LoadedSkill => ({ name, content, meta });

  it("indexes stacks, domain skills, and IDF weights", () => {
    const skills = new Map<string, LoadedSkill>([
      [
        "testing",
        makeSkill("testing skill", "jest unit testing guide", {
          keywords: ["jest"],
          domain: true,
          stacks: ["typescript"],
          priority: 2,
        }),
      ],
      [
        "coding",
        makeSkill("coding", "general programming", {
          keywords: [],
          domain: false,
          stacks: ["typescript"],
          priority: 1,
        }),
      ],
    ]);

    const index = buildSkillIndex(skills, tokenise);
    expect(index.stackToSkill.get("typescript")).toBe("testing");
    expect(index.domainSkillNames.has("testing")).toBe(true);
    expect(index.skillCount).toBe(2);
    expect(index.entries.has("testing")).toBe(true);
    expect(index.idf.get("jest")).toBeDefined();
    expect(index.idf.get("jest")).toBeGreaterThanOrEqual(0);
  });

  it("scores distinctive task words higher than generic corpus terms", () => {
    const skills = new Map<string, LoadedSkill>([
      [
        "jest",
        makeSkill("jest", "jest matchers and mocks", {
          keywords: ["jest"],
          domain: false,
          stacks: [],
          priority: 0,
        }),
      ],
      [
        "react",
        makeSkill("react", "react components", {
          keywords: ["react"],
          domain: false,
          stacks: [],
          priority: 0,
        }),
      ],
    ]);
    const index = buildSkillIndex(skills, tokenise);
    const jestEntry = index.entries.get("jest")!;
    const reactEntry = index.entries.get("react")!;

    const taskWords = new Set(tokenise("write jest unit tests"));
    const jestScore = scoreSkillForTask(jestEntry, taskWords, index.idf);
    const reactScore = scoreSkillForTask(reactEntry, taskWords, index.idf);
    expect(jestScore).toBeGreaterThan(reactScore);
  });
});
