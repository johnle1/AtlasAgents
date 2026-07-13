/**
 * Integration tests — Command catalog autocomplete flow
 *
 * Simulates the full autocomplete lifecycle that happens when a user types
 * a slash-command in the CLI input. The real application wires together:
 *
 *   getCommandSuggestions  →  commandRequiresArgs  →  getCommandLabel
 *
 * These three functions are called in sequence in useKeyboardInput.ts.
 * This integration test ensures the full pipeline produces consistent,
 * correct results without any internal mocking.
 *
 * Testing pyramid layer : Integration
 * Runner                 : Vitest
 * Real modules wired     : commandCatalog (all four exported functions)
 * Mocks                  : none — all functions are pure over in-memory state
 *
 * What integration tests catch that unit tests miss
 * -------------------------------------------------
 *   - The suggestion list and the requiresArgs / label lookups all reference
 *     the SAME `COMMAND_CATALOG` array. An integration test verifies that a
 *     command returned by `getCommandSuggestions` can always be looked up
 *     successfully by `commandRequiresArgs` and `getCommandLabel`.
 *   - If a command is added to the catalog but its requiresArgs flag is
 *     accidentally omitted, this test will catch it.
 *
 * Category checklist:
 *   ✅ Happy path         — realistic typing sequences, full round-trips
 *   ✅ System-level edges — empty results, no-args commands
 *   ✅ Failure propagation — no match → safe empty state throughout
 *   ✅ Contract consistency — every suggestion is fully resolvable by label/desc
 *   ✅ State integrity     — narrowing from broad to exact prefix stays consistent
 */

import { describe, expect, it } from "vitest";
import {
  commandRequiresArgs,
  getCommandDescription,
  getCommandLabel,
  getCommandSuggestions,
} from "../../packages/client/src/ui/commandCatalog";

// ---------------------------------------------------------------------------
// Helper — simulate the UI selecting a suggestion and resolving its metadata
// ---------------------------------------------------------------------------

/**
 * Mimics what the Ink UI does when a user tabs through autocomplete:
 *  1. Retrieve suggestions matching the typed prefix.
 *  2. Pick the suggestion at `selectedIndex`.
 *  3. Determine whether to append a space (command requires args).
 *  4. Fetch the label for display.
 *
 * @returns An object describing what the UI would show/set.
 */
function simulateAutocompleteSelection(
  input: string,
  selectedIndex: number,
): {
  selectedCommand: string | undefined;
  inputAfterTab: string;
  label: string;
  description: string;
  requiresArgs: boolean;
} {
  const suggestions = getCommandSuggestions(input);
  const selected = suggestions[selectedIndex];

  if (!selected) {
    return {
      selectedCommand: undefined,
      inputAfterTab: input,
      label: "",
      description: "",
      requiresArgs: false,
    };
  }

  const needsArgs = commandRequiresArgs(selected.command);
  return {
    selectedCommand: selected.command,
    // The real keyboard handler appends a space when the command needs args
    inputAfterTab: selected.command + (needsArgs ? " " : ""),
    label: getCommandLabel(selected.command),
    description: getCommandDescription(selected.command),
    requiresArgs: needsArgs,
  };
}

// ---------------------------------------------------------------------------
// Realistic typing sequences — user types character by character
// ---------------------------------------------------------------------------

describe("Autocomplete flow — progressive narrowing", () => {
  it("'/' returns many suggestions; '/m' narrows to /models and /memory; '/mo' narrows further", () => {
    const allSuggestions = getCommandSuggestions("/");
    const mSuggestions = getCommandSuggestions("/m");
    const moSuggestions = getCommandSuggestions("/mo");

    // Each narrowing step should reduce the suggestion count
    expect(allSuggestions.length).toBeGreaterThan(mSuggestions.length);
    expect(mSuggestions.length).toBeGreaterThan(moSuggestions.length);

    // /m should include both /models and /memory commands
    const mCommands = mSuggestions.map((s) => s.command);
    expect(mCommands.some((c) => c.startsWith("/models"))).toBe(true);
    expect(mCommands.some((c) => c.startsWith("/memory"))).toBe(true);

    // /mo should only include /models commands (not /memory which starts with /me)
    const moCommands = moSuggestions.map((s) => s.command);
    expect(moCommands.every((c) => c.startsWith("/mo"))).toBe(true);
    expect(moCommands.some((c) => c.startsWith("/memory"))).toBe(false);
  });

  it("'/se' narrows to /set sub-commands only", () => {
    const suggestions = getCommandSuggestions("/se");
    const commands = suggestions.map((s) => s.command);
    expect(commands.every((c) => c.startsWith("/se"))).toBe(true);
    expect(commands).toContain("/set password");
    expect(commands).toContain("/set server");
    expect(commands).toContain("/set port");
  });

  it("typing the full '/models pull' produces exactly one result", () => {
    const suggestions = getCommandSuggestions("/models pull");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.command).toBe("/models pull");
  });
});

// ---------------------------------------------------------------------------
// Happy path — full Tab autocomplete round-trip
// ---------------------------------------------------------------------------

describe("Tab autocomplete round-trip — happy path", () => {
  it("selecting '/set password' appends a space and provides a label (happy path)", () => {
    const result = simulateAutocompleteSelection("/set", 0);
    // The first /set suggestion should be /set password
    expect(result.selectedCommand).toBe("/set password");
    // A space is appended because /set password requires args
    expect(result.inputAfterTab).toBe("/set password ");
    expect(result.requiresArgs).toBe(true);
    // The label should include the placeholder hint
    expect(result.label).toContain("[value]");
    // The description should be non-empty
    expect(result.description.length).toBeGreaterThan(0);
  });

  it("selecting '/help' does NOT append a space (happy path — no args needed)", () => {
    const result = simulateAutocompleteSelection("/hel", 0);
    expect(result.selectedCommand).toBe("/help");
    expect(result.inputAfterTab).toBe("/help");
    expect(result.requiresArgs).toBe(false);
  });

  it("selecting '/models pull' appends a space for the model name arg (happy path)", () => {
    const suggestions = getCommandSuggestions("/models pul");
    expect(suggestions.length).toBeGreaterThan(0);
    const result = simulateAutocompleteSelection("/models pul", 0);
    expect(result.selectedCommand).toBe("/models pull");
    expect(result.inputAfterTab).toBe("/models pull ");
    expect(result.requiresArgs).toBe(true);
    expect(result.label).toContain("<name>");
  });

  it("selecting '/models list' does NOT append a space (happy path — no args)", () => {
    const result = simulateAutocompleteSelection("/models list", 0);
    expect(result.selectedCommand).toBe("/models list");
    expect(result.inputAfterTab).toBe("/models list");
    expect(result.requiresArgs).toBe(false);
  });

  it("selecting '/config' provides description text (happy path)", () => {
    const result = simulateAutocompleteSelection("/con", 0);
    expect(result.selectedCommand).toBe("/config");
    expect(result.description.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Contract consistency — every suggestion is fully resolvable
// ---------------------------------------------------------------------------

describe("Catalog contract consistency", () => {
  it("every suggestion returned by getCommandSuggestions has a resolvable label (contract)", () => {
    const allSuggestions = getCommandSuggestions("/");
    for (const suggestion of allSuggestions) {
      // getCommandLabel must return a non-empty string for every catalog entry
      const label = getCommandLabel(suggestion.command);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("every suggestion returned has a resolvable description (contract)", () => {
    const allSuggestions = getCommandSuggestions("/");
    for (const suggestion of allSuggestions) {
      const desc = getCommandDescription(suggestion.command);
      // All catalog entries must have a description
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(0);
    }
  });

  it("every suggestion's requiresArgs resolves without error (contract)", () => {
    const allSuggestions = getCommandSuggestions("/");
    for (const suggestion of allSuggestions) {
      // Must return a boolean — never undefined or throw
      const result = commandRequiresArgs(suggestion.command);
      expect(typeof result).toBe("boolean");
    }
  });

  it("commands marked requiresArgs: true in catalog have a label with a placeholder (contract)", () => {
    // Commands that need args should have labels that indicate this to the user
    // (e.g., '/set password [value]' or '/models pull <name>')
    const allSuggestions = getCommandSuggestions("/");
    const requiresArgsSuggestions = allSuggestions.filter((s) =>
      commandRequiresArgs(s.command),
    );

    for (const suggestion of requiresArgsSuggestions) {
      const label = getCommandLabel(suggestion.command);
      // The label should differ from the bare command (it has a placeholder)
      // OR the command itself contains the placeholder notation
      const hasPlaceholder =
        label.includes("[") ||
        label.includes("<") ||
        label !== suggestion.command;
      expect(hasPlaceholder).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure propagation — no-match input stays safe throughout the pipeline
// ---------------------------------------------------------------------------

describe("No-match input propagation", () => {
  it("empty input → empty suggestions → no label/desc lookup performed (failure)", () => {
    const result = simulateAutocompleteSelection("", 0);
    expect(result.selectedCommand).toBeUndefined();
    // Input remains unchanged when no suggestion is selected
    expect(result.inputAfterTab).toBe("");
    expect(result.label).toBe("");
    expect(result.description).toBe("");
    expect(result.requiresArgs).toBe(false);
  });

  it("unknown prefix → empty suggestions → index 0 returns nothing safely (failure)", () => {
    const result = simulateAutocompleteSelection("/zzzunknown", 0);
    expect(result.selectedCommand).toBeUndefined();
    expect(result.inputAfterTab).toBe("/zzzunknown");
  });

  it("valid prefix but out-of-bounds index → no selection, input unchanged (failure)", () => {
    // '/help' has only 1 suggestion; index 5 is out of bounds
    const result = simulateAutocompleteSelection("/hel", 5);
    expect(result.selectedCommand).toBeUndefined();
    expect(result.inputAfterTab).toBe("/hel");
  });

  it("plain text input → zero suggestions → pipeline short-circuits (failure)", () => {
    const result = simulateAutocompleteSelection("build the project", 0);
    expect(result.selectedCommand).toBeUndefined();
    expect(getCommandSuggestions("build the project")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// State integrity — narrowing then expanding stays consistent
// ---------------------------------------------------------------------------

describe("State integrity — narrowing and expanding", () => {
  it("narrowing to '/models pull' then backspacing to '/models p' re-expands correctly", () => {
    const narrow = getCommandSuggestions("/models pull");
    const expanded = getCommandSuggestions("/models p");
    // Expanded should include pull AND find a match for 'p' prefix if any
    expect(expanded.length).toBeGreaterThanOrEqual(narrow.length);
    // The exact match must still be in the expanded set
    expect(expanded.map((s) => s.command)).toContain("/models pull");
  });

  it("typing '/' then '/h' then '/he' then '/help' shows monotonically decreasing suggestions", () => {
    const counts = ["/", "/h", "/he", "/hel", "/help"].map(
      (prefix) => getCommandSuggestions(prefix).length,
    );
    // Each step should be <= the previous (non-increasing)
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]!);
    }
    // The final exact match should return exactly 1
    expect(counts[counts.length - 1]).toBe(1);
  });
});
