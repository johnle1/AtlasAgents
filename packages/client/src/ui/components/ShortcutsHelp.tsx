/**
 * Overlay listing every bound keyboard shortcut.
 *
 * @remarks
 * Rendered from {@link SHORTCUT_CATALOG} so the on-screen cheat-sheet cannot
 * drift from the catalog (or from {@link HANDLED_KEYS}, which the catalog
 * test diffs). Mounted by {@link App} when `showShortcuts` is true and no
 * approval / prompt overlay is active.
 */

import React from "react";
import { Box, Text } from "ink";

import { SHORTCUT_CATALOG } from "../shortcutCatalog.js";

/**
 * Bordered shortcuts cheat-sheet for the `?` key.
 *
 * @example
 * ```tsx
 * {showShortcuts && !busy && !approval && !promptReq && <ShortcutsHelp />}
 * ```
 */
export const ShortcutsHelp: React.FC = () => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor="gray"
    paddingX={1}
  >
    <Text bold>Keyboard shortcuts</Text>
    {SHORTCUT_CATALOG.map((entry) => (
      <Box key={entry.id}>
        <Text color="green">{entry.keys.padEnd(10)}</Text>
        <Text dimColor>{entry.action}</Text>
      </Box>
    ))}
    <Text dimColor>Press any key to close</Text>
  </Box>
);
