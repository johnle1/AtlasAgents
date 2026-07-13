/**
 * Unit tests — commandCatalog.ts
 *
 * Tests the four public helpers that power CLI autocomplete:
 *   - getCommandSuggestions  — filters catalog by typed prefix
 *   - commandRequiresArgs    — looks up the requiresArgs flag
 *   - getCommandLabel        — returns the display label string
 *   - getCommandDescription  — returns the description string
 *
 * Testing pyramid layer : Unit
 * Runner                 : Vitest
 * Mocks                  : none (pure functions over in-memory catalog)
 *
 * Category checklist:
 *   ✅ Normal  — typical user inputs and known commands
 *   ✅ Boundary — empty input, bare slash, exact match, unknown command
 *   ✅ Error   — completely unknown commands, no match scenarios
 */

import { describe, expect, it } from "vitest";
import {
  commandRequiresArgs,
  getCommandDescription,
  getCommandLabel,
  getCommandSuggestions,
} from "../../packages/client/src/ui/commandCatalog";

// ---------------------------------------------------------------------------
// getCommandSuggestions
// ---------------------------------------------------------------------------

describe("getCommandSuggestions — normal cases", () => {
  it("returns all commands starting with '/set' (normal — prefix match)", () => {
    // Typing '/set' should surface the three /set sub-commands
    const suggestions = getCommandSuggestions("/set");
    const commands = suggestions.map((s) => s.command);
    expect(commands).toContain("/set password");
    expect(commands).toContain("/set server");
    expect(commands).toContain("/set port");
  });

  it("returns all /models sub-commands when typing '/models' (normal)", () => {
    const suggestions = getCommandSuggestions("/models");
    const commands = suggestions.map((s) => s.command);
    expect(commands).toContain("/models list");
    expect(commands).toContain("/models pull");
    expect(commands).toContain("/models delete");
    expect(commands).toContain("/models show");
    expect(commands).toContain("/models running");
    expect(commands).toContain("/models find");
  });

  it("returns memory commands when typing '/memory' (normal)", () => {
    const suggestions = getCommandSuggestions("/memory");
    const commands = suggestions.map((s) => s.command);
    expect(commands).toContain("/memory show");
    expect(commands).toContain("/memory forget");
    expect(commands).toContain("/memory clear");
  });

  it("returns only matching entry for '/models list' exact prefix (normal)", () => {
    // Typing the full command name still returns it (startsWith matches itself)
    const suggestions = getCommandSuggestions("/models list");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.command).toBe("/models list");
  });

  it("returns /skills commands when typing '/skills' (normal)", () => {
    const suggestions = getCommandSuggestions("/skills");
    const commands = suggestions.map((s) => s.command);
    expect(commands).toContain("/skills list");
    expect(commands).toContain("/skills add");
    expect(commands).toContain("/skills sync");
  });
});

describe("getCommandSuggestions — boundary cases", () => {
  it("returns the complete catalog when input is bare '/' (boundary — widest prefix)", () => {
    // Every command starts with '/' so all should be returned
    const all = getCommandSuggestions("/");
    expect(all.length).toBeGreaterThan(10);
    // Spot-check a few known commands exist in the result
    const commands = all.map((s) => s.command);
    expect(commands).toContain("/help");
    expect(commands).toContain("/exit");
    expect(commands).toContain("/new");
  });

  it("returns empty array for empty string (boundary — no slash)", () => {
    // A user who hasn't typed '/' yet should see no autocomplete
    expect(getCommandSuggestions("")).toEqual([]);
  });

  it("returns empty array for plain text without a slash (boundary)", () => {
    expect(getCommandSuggestions("write a unit test")).toEqual([]);
  });

  it("narrows to exactly '/help' when typing '/hel' (boundary — narrow prefix)", () => {
    const suggestions = getCommandSuggestions("/hel");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.command).toBe("/help");
  });

  it("narrows to '/models find' and '/models forget' area when typing '/mo' (boundary)", () => {
    // '/mo' matches both /models and /memory only if they start with '/mo'
    // memory starts with '/me', so only /models commands should match
    const suggestions = getCommandSuggestions("/mo");
    const commands = suggestions.map((s) => s.command);
    expect(commands.every((c) => c.startsWith("/mo"))).toBe(true);
    expect(commands.every((c) => !c.startsWith("/me"))).toBe(true);
  });
});

describe("getCommandSuggestions — error / no-match cases", () => {
  it("returns empty array for an unknown command prefix (error — no match)", () => {
    expect(getCommandSuggestions("/foobarnotexistent")).toEqual([]);
  });

  it("returns empty array when input starts with a letter not a slash (error)", () => {
    expect(getCommandSuggestions("models list")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// commandRequiresArgs
// ---------------------------------------------------------------------------

describe("commandRequiresArgs — normal cases", () => {
  it("returns true for /set password (normal — requires arg)", () => {
    expect(commandRequiresArgs("/set password")).toBe(true);
  });

  it("returns true for /set server (normal)", () => {
    expect(commandRequiresArgs("/set server")).toBe(true);
  });

  it("returns true for /skills add (normal)", () => {
    expect(commandRequiresArgs("/skills add")).toBe(true);
  });

  it("returns true for /models pull (normal)", () => {
    expect(commandRequiresArgs("/models pull")).toBe(true);
  });

  it("returns false for /config (normal — no args needed)", () => {
    expect(commandRequiresArgs("/config")).toBe(false);
  });

  it("returns false for /help (normal — no args needed)", () => {
    expect(commandRequiresArgs("/help")).toBe(false);
  });

  it("returns false for /new (normal — no args)", () => {
    expect(commandRequiresArgs("/new")).toBe(false);
  });
});

describe("commandRequiresArgs — boundary / error cases", () => {
  it("returns false for an unknown command (boundary — safe default)", () => {
    // Unknown commands should not falsely claim they require args
    expect(commandRequiresArgs("/unknown-command-xyz")).toBe(false);
  });

  it("returns false for an empty string (boundary)", () => {
    expect(commandRequiresArgs("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getCommandLabel
// ---------------------------------------------------------------------------

describe("getCommandLabel — normal cases", () => {
  it("returns label with placeholder for /set password (normal)", () => {
    expect(getCommandLabel("/set password")).toBe("/set password [value]");
  });

  it("returns label with placeholder for /set server (normal)", () => {
    expect(getCommandLabel("/set server")).toBe("/set server [host]");
  });

  it("returns label with placeholder for /models pull (normal)", () => {
    expect(getCommandLabel("/models pull")).toBe("/models pull <name>");
  });
});

describe("getCommandLabel — boundary / fallback cases", () => {
  it("falls back to the command string itself when no label is defined (boundary)", () => {
    // Commands with no 'label' field fall back to the command string
    expect(getCommandLabel("/config")).toBe("/config");
    expect(getCommandLabel("/help")).toBe("/help");
  });

  it("falls back to the input string for unknown commands (error)", () => {
    expect(getCommandLabel("/totally-unknown")).toBe("/totally-unknown");
  });
});

// ---------------------------------------------------------------------------
// getCommandDescription
// ---------------------------------------------------------------------------

describe("getCommandDescription — normal cases", () => {
  it("returns a non-empty description for /help (normal)", () => {
    const desc = getCommandDescription("/help");
    expect(typeof desc).toBe("string");
    expect(desc.length).toBeGreaterThan(0);
  });

  it("returns description for /set password (normal)", () => {
    const desc = getCommandDescription("/set password");
    expect(desc).toContain("password");
  });

  it("returns description for /models list (normal)", () => {
    const desc = getCommandDescription("/models list");
    expect(desc.length).toBeGreaterThan(0);
  });
});

describe("getCommandDescription — boundary / error cases", () => {
  it("returns empty string for unknown command (error — safe fallback)", () => {
    expect(getCommandDescription("/not-a-real-command")).toBe("");
  });

  it("returns empty string for empty string input (boundary)", () => {
    expect(getCommandDescription("")).toBe("");
  });
});
