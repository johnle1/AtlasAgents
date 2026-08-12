/**
 * Unit tests — client ui/shortcutCatalog.ts
 *
 * The cheat-sheet is the user-facing list of keys; HANDLED_KEYS is what
 * createKeyHandler actually consumes. This file pins them together so a
 * new binding cannot ship without a catalog row (and vice versa for ids
 * the handler owns).
 *
 * Category checklist:
 * - Normal: catalog lists every HANDLED_KEYS id
 * - Boundary: catalog also documents Enter (bound by the input box)
 */

import { describe, expect, it } from "vitest";
import { HANDLED_KEYS } from "../../../../packages/client/src/ui/hooks/keyHandler.js";
import { SHORTCUT_CATALOG } from "../../../../packages/client/src/ui/shortcutCatalog.js";

describe("SHORTCUT_CATALOG", () => {
  it("covers every key createKeyHandler handles (normal — drift guard)", () => {
    const catalogIds = SHORTCUT_CATALOG.map((entry) => entry.id);
    for (const key of HANDLED_KEYS) {
      expect(catalogIds).toContain(key);
    }
  });

  it("lists Enter, which the input box binds (boundary)", () => {
    expect(SHORTCUT_CATALOG.some((entry) => entry.id === "enter")).toBe(true);
  });

  it("gives every entry a keys label and an action description (normal)", () => {
    for (const entry of SHORTCUT_CATALOG) {
      expect(entry.keys.length).toBeGreaterThan(0);
      expect(entry.action.length).toBeGreaterThan(0);
    }
  });
});
