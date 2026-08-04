/**
 * Unit tests — commandClassifier.ts (normalize, match, purpose, think validation).
 */

import { describe, expect, it } from "vitest";
import {
  RUN_PROJECT_BLOCK_MESSAGE,
  VERIFY_REQUIRED_MESSAGE,
  commandMatchesPlanEntry,
  formatCommandPlanBlock,
  hasCommandPlanSection,
  hasRunCommandThinkFields,
  inferPurpose,
  normalizeCommand,
} from "../../../../packages/server/src/orchestration/commandClassifier.js";
import type { CommandPlan } from "../../../../packages/server/src/orchestration/types.js";

describe("normalizeCommand", () => {
  it("trims, collapses whitespace, and lowercases", () => {
    expect(normalizeCommand("  NPM   Test  ")).toBe("npm test");
  });
});

describe("commandMatchesPlanEntry", () => {
  it("matches exact normalized command", () => {
    expect(commandMatchesPlanEntry("npm test", "NPM TEST")).toBe(true);
  });

  it("matches when command extends entry with a space", () => {
    expect(commandMatchesPlanEntry("npm test --watch", "npm test")).toBe(true);
  });

  it("returns false for empty entry", () => {
    expect(commandMatchesPlanEntry("npm test", "   ")).toBe(false);
  });
});

describe("inferPurpose", () => {
  const plan: CommandPlan = {
    setupCommands: ["npm install"],
    verifyCommands: ["npm test"],
    runProjectCommands: ["npm run dev"],
  };

  it("classifies run-project commands first", () => {
    expect(inferPurpose("npm run dev", plan)).toBe("run-project");
  });

  it("classifies verify commands", () => {
    expect(inferPurpose("npm test", plan)).toBe("verify");
  });

  it("defaults to setup", () => {
    expect(inferPurpose("npm install", plan)).toBe("setup");
    expect(inferPurpose("make build", plan)).toBe("setup");
  });
});

describe("formatCommandPlanBlock", () => {
  it("lists commands and shows (none) for empty sections", () => {
    const block = formatCommandPlanBlock({
      setupCommands: ["npm ci"],
      verifyCommands: [],
      runProjectCommands: ["npm start"],
    });
    expect(block).toContain("[Agent command plan]");
    expect(block).toContain("  - npm ci");
    expect(block).toContain("Verify (exit pass/fail):");
    expect(block).toContain("  (none)");
    expect(block).toContain("  - npm start");
  });
});

describe("RUN_PROJECT_BLOCK_MESSAGE", () => {
  it("includes the blocked command and guidance", () => {
    const msg = RUN_PROJECT_BLOCK_MESSAGE("npm run dev");
    expect(msg).toContain("npm run dev");
    expect(msg).toContain("background: true");
    expect(msg).toContain("verify command");
  });
});

describe("VERIFY_REQUIRED_MESSAGE", () => {
  it("lists paths and verification options", () => {
    const msg = VERIFY_REQUIRED_MESSAGE(new Set(["a.ts", "b.ts"]));
    expect(msg).toContain("a.ts");
    expect(msg).toContain("b.ts");
    expect(msg).toContain("verify your work");
    expect(msg).toContain("NOT verification");
  });
});

describe("hasRunCommandThinkFields", () => {
  it("returns false for null or missing fields", () => {
    expect(hasRunCommandThinkFields(null)).toBe(false);
    expect(hasRunCommandThinkFields("purpose: setup")).toBe(false);
  });

  it("returns true when purpose, exits, and risk are present", () => {
    const think = `
purpose: verify
exits: yes
risk: low — read-only test
`;
    expect(hasRunCommandThinkFields(think)).toBe(true);
  });
});

describe("hasCommandPlanSection", () => {
  it("requires setup, verify, and off-limits headers", () => {
    expect(
      hasCommandPlanSection(
        "setup commands: npm ci\nverify commands: npm test\noff-limits: npm run dev",
      ),
    ).toBe(true);
  });

  it("returns false when off-limits is missing", () => {
    expect(
      hasCommandPlanSection("setup commands: x\nverify commands: y"),
    ).toBe(false);
  });
});
