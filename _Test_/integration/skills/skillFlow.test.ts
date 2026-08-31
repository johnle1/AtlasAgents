/**
 * Integration tests — skills on disk → relevance selection, and the
 * `skills.sync` route → disk round trip.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : SkillManager + skillMeta + skillHelpers against a
 *                          real temp `user-data/skills/` directory, and the
 *                          real buildRouter/`Router.routeCommand` entry point
 *                          for `skills.sync` (same harness style as
 *                          routerCommandFlow.test.ts).
 * Mocks                  : none at the skill layer — the whole flow runs on a
 *                          temp filesystem; other router deps are typed stubs.
 *
 * Two flows are covered because they have genuinely different metadata
 * behavior:
 *  A. Skills placed on disk directly (inline `skill-meta` block or
 *     `.meta.json` sidecar) keep their metadata → stack-mapped and
 *     domain-aware `selectForTask`.
 *  B. Skills arriving via `skills.sync` are written as cleaned bodies only
 *     (saveAll strips the inline block and writes no sidecar) → selection
 *     still works via name/body scoring.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  Session,
  RouterBuilderDeps,
} from "../../../packages/server/src/routing/types.js";
import { buildRouter } from "../../../packages/server/src/routing/routerBuilder.js";
import { ConfigManager } from "../../../packages/server/src/config/index.js";
import { lockCipher } from "@atlasagents/shared";
import { OllamaClient } from "../../../packages/server/src/ollama/client.js";
import { ProviderRegistry } from "../../../packages/server/src/providers/providerRegistry.js";
import { SkillManager } from "../../../packages/server/src/skills/skillManager.js";
import { SKILLS_REL_DIR } from "../../../packages/server/src/skills/skillConstants.js";
import { McpToolsCacheStore } from "../../../packages/server/src/orchestration/mcp/mcpToolsCacheStore.js";

const tempRoots: string[] = [];

afterEach(async () => {
  lockCipher();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const SESSION: Session = { userId: "user_1", requesterId: "req_1" };

const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-skill-flow-"));
  tempRoots.push(root);
  return root;
};

const skillsDirOf = (root: string): string => path.join(root, SKILLS_REL_DIR);

// ---------------------------------------------------------------------------
// A. Disk → metadata-aware selection
// ---------------------------------------------------------------------------

const TYPESCRIPT_SKILL = `# TypeScript skill
\`\`\`json skill-meta
{"stacks": ["typescript", "javascript"], "keywords": ["types", "compiler"]}
\`\`\`
Always prefer strict types. Run tsc before committing.
`;

const REVIEW_SKILL = `# Review skill
\`\`\`json skill-meta
{"domain": true, "keywords": ["review", "refactor", "readability"]}
\`\`\`
When reviewing, check naming, duplication, and error handling first.
`;

const PLAIN_SKILL = `# Notes skill
General note-taking guidance with no metadata at all.
`;

/** Writes skill files directly, bypassing the sync route (metadata kept). */
const seedSkillsOnDisk = async (root: string): Promise<SkillManager> => {
  const dir = skillsDirOf(root);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "typescript.md"), TYPESCRIPT_SKILL);
  await fs.writeFile(path.join(dir, "review.md"), REVIEW_SKILL);
  await fs.writeFile(path.join(dir, "notes.md"), PLAIN_SKILL);
  return new SkillManager({ rootDir: root });
};

describe("disk → selectForTask — metadata-aware selection", () => {
  it("prefers the stack-mapped skill for a matching detectedStack", async () => {
    const root = await makeRoot();
    const manager = await seedSkillsOnDisk(root);

    const selected = await manager.selectForTask("tidy up this module", {
      detectedStack: "TypeScript",
    });

    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0].name).toBe("typescript");
    // The body comes back cleaned — metadata block stripped, heading kept.
    expect(selected[0].content).toContain("strict types");
    expect(selected[0].content).not.toContain("skill-meta");
  });

  it("appends a domain-relevant skill as the second result when it scores well", async () => {
    const root = await makeRoot();
    const manager = await seedSkillsOnDisk(root);

    const selected = await manager.selectForTask(
      "review this refactor for readability",
      { detectedStack: "typescript" },
    );

    expect(selected.map((skill) => skill.name)).toEqual([
      "typescript",
      "review",
    ]);
  });

  it("reads metadata from a .meta.json sidecar when the markdown has none", async () => {
    const root = await makeRoot();
    const dir = skillsDirOf(root);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "python.md"),
      "# Python skill\nUse uv, not pip. Type-hint everything.\n",
    );
    await fs.writeFile(
      path.join(dir, "python.meta.json"),
      JSON.stringify({ stacks: ["python"], keywords: ["uv"] }),
    );
    const manager = new SkillManager({ rootDir: root });

    const selected = await manager.selectForTask("whatever task", {
      detectedStack: "python",
    });

    expect(selected[0]?.name).toBe("python");
  });

  it("falls back to name/body scoring when no stack matches", async () => {
    const root = await makeRoot();
    const manager = await seedSkillsOnDisk(root);

    const selected = await manager.selectForTask(
      "review the error handling in this diff",
    );

    // No stack context: the review skill's keyword/body match should win the
    // primary slot outright.
    expect(selected[0].name).toBe("review");
  });
});

describe("disk → selection reflects mutations (index invalidation)", () => {
  it("a deleted skill stops winning selection on the next call", async () => {
    const root = await makeRoot();
    const manager = await seedSkillsOnDisk(root);

    const before = await manager.selectForTask("review this refactor", {
      detectedStack: "typescript",
    });
    expect(before.map((skill) => skill.name)).toContain("review");

    await manager.delete("review");

    const after = await manager.selectForTask("review this refactor", {
      detectedStack: "typescript",
    });
    expect(after.map((skill) => skill.name)).not.toContain("review");
    expect(await manager.list()).not.toContain("review");
  });
});

// ---------------------------------------------------------------------------
// B. skills.sync route → disk → loadAll round trip
// ---------------------------------------------------------------------------

const makeRouter = (config: ConfigManager, skills: SkillManager) => {
  const ollama = new OllamaClient();
  const deps: RouterBuilderDeps = {
    ollama,
    providerRegistry: new ProviderRegistry({ config, ollamaClient: ollama }),
    config,
    skills,
    prefs: {
      getAll: async () => [],
      deleteByTopic: async () => 0,
      clear: async () => {},
    },
    session: {
      exists: async () => false,
      clear: async () => "",
      saveSnapshot: async () => {},
    },
    orchestrator: { runTask: async () => {} },
    brokerByRequester: new Map(),
    mcpToolsCacheStore: new McpToolsCacheStore({
      rootDir: path.join(os.tmpdir(), "atlas-skill-flow-mcp-cache"),
    }),
    createPerConnection: () => {
      throw new Error("not used by these tests");
    },
    preferenceRulesToMemoryEntries: () => [],
  };
  return buildRouter(deps);
};

const makeRouterEnv = async () => {
  const root = await makeRoot();
  const config = new ConfigManager({ rootDir: root });
  await config.unlockOrSetupProvidersCipher(async () => "skill-flow-pass");
  const skills = new SkillManager({ rootDir: root });
  return { root, skills, router: makeRouter(config, skills) };
};

describe("skills.sync route → disk round trip", () => {
  it("persists synced skills as cleaned bodies and reloads them", async () => {
    const { root, skills, router } = await makeRouterEnv();

    const result = (await router.routeCommand(SESSION, "skills.sync", {
      skills: [
        { name: "typescript", content: TYPESCRIPT_SKILL },
        { name: "review", content: REVIEW_SKILL },
      ],
    })) as { saved: number };

    expect(result.saved).toBe(2);

    // On disk: the inline metadata block is stripped (saveAll writes the
    // cleaned body, no sidecar) — the file is pure markdown.
    const onDisk = await fs.readFile(
      path.join(skillsDirOf(root), "typescript.md"),
      "utf-8",
    );
    expect(onDisk).toContain("strict types");
    expect(onDisk).not.toContain("skill-meta");

    const loaded = await skills.loadAll();
    expect([...loaded.keys()].sort()).toEqual(["review", "typescript"]);
    expect(loaded.get("typescript")).toContain("strict types");
  });

  it("a later sync removes skills that are no longer in the set", async () => {
    const { skills, router } = await makeRouterEnv();

    await router.routeCommand(SESSION, "skills.sync", {
      skills: [
        { name: "typescript", content: TYPESCRIPT_SKILL },
        { name: "review", content: REVIEW_SKILL },
      ],
    });
    await router.routeCommand(SESSION, "skills.sync", {
      skills: [{ name: "typescript", content: TYPESCRIPT_SKILL }],
    });

    expect(await skills.list()).toEqual(["typescript"]);
    const loaded = await skills.loadAll();
    expect(loaded.has("review")).toBe(false);
  });

  it("synced skills remain selectable via name/body scoring", async () => {
    const { skills, router } = await makeRouterEnv();

    await router.routeCommand(SESSION, "skills.sync", {
      skills: [
        { name: "typescript", content: TYPESCRIPT_SKILL },
        { name: "notes", content: PLAIN_SKILL },
      ],
    });

    // No metadata survived the sync (see above), so selection works off the
    // body text alone — the typescript skill still wins a typescript task.
    const selected = await skills.selectForTask(
      "run the compiler and fix strict types",
    );
    expect(selected.length).toBeGreaterThan(0);
    expect(selected[0].name).toBe("typescript");
  });
});
