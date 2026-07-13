/**
 * Themed table/list printers for `/config`, `/set` model pick, skills, memory.
 *
 * @remarks
 * Builders return ANSI line arrays; `print*` wrappers push them through
 * {@link appendStyledLines} with consistent vertical spacing.
 */

import type { Config } from "../config.js";
import type { MemoryEntry } from "../connection/index.js";
import { getTheme } from "../theme/themeManager.js";
import { THEMES } from "../theme/themes.js";
import { appendStyledLines } from "./sink.js";

/**
 * Masks a secret for config display (password / tokens).
 *
 * @remarks
 * Empty → `(not set)`. Length ≤ 4 → `****` (never show any character). Longer
 * values show only the last 4 chars with an ellipsis so users can tell secrets
 * apart without printing the whole value.
 *
 * @param secret - Raw secret from config.
 * @returns Themed masked string.
 */
const formatSecretDisplay = (secret: string): string => {
  const theme = getTheme();
  const trimmedSecret = secret.trim();

  if (!trimmedSecret) {
    return `${theme.textSecondary}(not set)${theme.reset}`;
  }

  // Short secrets would be fully revealed by a “last 4” policy — hide entirely.
  if (trimmedSecret.length <= 4) {
    return `${theme.textSecondary}****${theme.reset}`;
  }

  return `${theme.textSecondary}…${theme.reset}${trimmedSecret.slice(-4)}`;
};

/**
 * Builds ANSI lines describing the current {@link Config} snapshot.
 *
 * @remarks
 * Password is masked. Missing models render as `(not set)`. Theme shows both
 * human name and id. Includes slash-command hints for cap / think toggles.
 *
 * @param config - Loaded client configuration.
 * @returns Styled lines ready for {@link appendStyledLines}.
 *
 * @example
 * ```ts
 * const lines = buildConfigLines(loadConfig());
 * ```
 */
export const buildConfigLines = (config: Config): string[] => {
  const theme = getTheme();
  const resolvedThemeName = THEMES[config.ui.theme]?.name ?? config.ui.theme;
  // Undefined spinner preference = on (same rule as /spinner status).
  const spinnerState = config.ui.showSpinner !== false ? "on" : "off";

  return [
    `${theme.textBold}  Current Configuration${theme.reset}`,
    `${theme.textSecondary}  ${"─".repeat(34)}${theme.reset}`,
    `  ${theme.textAccent}server${theme.reset}         ${config.server}`,
    `  ${theme.textAccent}port${theme.reset}           ${config.port}`,
    `  ${theme.textAccent}password${theme.reset}       ${formatSecretDisplay(config.password)}`,
    `  ${theme.textAccent}advisor model${theme.reset}  ${config.advisorModel || theme.textSecondary + "(not set)" + theme.reset}`,
    `  ${theme.textAccent}agent model${theme.reset}    ${config.agentModel || theme.textSecondary + "(not set)" + theme.reset}`,
    `  ${theme.textAccent}agent cap${theme.reset}      ${config.agentCap} (/agent cap, ::max for no cap)`,
    `  ${theme.textAccent}ui.theme${theme.reset}       ${resolvedThemeName} (${config.ui.theme})`,
    `  ${theme.textAccent}show think${theme.reset}     ${config.showThinkOutput ? "on" : "off"} (/think on|off)`,
    `  ${theme.textAccent}show spinner${theme.reset}   ${spinnerState}`,
  ];
};

/**
 * Builds a 1-based numbered model list for advisor/agent picking.
 *
 * @param models - Model name strings from the server.
 * @param label - Role label in the header (`"advisor"` / `"agent"`).
 * @returns Styled lines including trailing blank.
 */
const buildModelsLines = (models: string[], label: string): string[] => {
  const theme = getTheme();
  const modelLines = [
    `${theme.textBold}  Available models for ${label}:${theme.reset}`,
    "",
  ];

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    // padStart keeps 1..N aligned when the list grows past 9.
    modelLines.push(
      `  ${theme.warning}${String(modelIndex + 1).padStart(3)}${theme.reset}  ${models[modelIndex]}`,
    );
  }

  modelLines.push("");
  return modelLines;
};

/**
 * Builds a bullet list of local skill names (or an empty-state hint).
 *
 * @param names - Skill basenames.
 * @returns Styled lines.
 */
const buildSkillsLines = (names: string[]): string[] => {
  const theme = getTheme();

  if (names.length === 0) {
    return [
      `${theme.textSecondary}  No skills found. Use /skills add <name> to create one.${theme.reset}`,
      "",
    ];
  }

  const skillLines = [
    `${theme.textBold}  Skills (${names.length}):${theme.reset}`,
    "",
  ];

  for (const skillName of names) {
    skillLines.push(`  ${theme.textAccent}•${theme.reset} ${skillName}`);
  }

  skillLines.push("");
  return skillLines;
};

/**
 * Builds topic/rule lines for the server memory preference store.
 *
 * @param entries - Memory topics with rule strings.
 * @returns Styled lines (empty-state when no entries).
 */
const buildMemoryLines = (entries: MemoryEntry[]): string[] => {
  const theme = getTheme();

  if (entries.length === 0) {
    return [`${theme.textSecondary}  No memories stored.${theme.reset}`, ""];
  }

  const memoryLines = [
    `${theme.textBold}  Stored Memories (${entries.length} topics):${theme.reset}`,
    "",
  ];

  for (const memoryEntry of entries) {
    memoryLines.push(`  ${theme.textAccent}${memoryEntry.topic}${theme.reset}`);
    for (const rule of memoryEntry.rules) {
      memoryLines.push(`    ${theme.textSecondary}→${theme.reset} ${rule}`);
    }
  }

  memoryLines.push("");
  return memoryLines;
};

/**
 * Prints the current configuration table to scrollback.
 *
 * @param config - Config snapshot to display.
 *
 * @example
 * ```ts
 * printConfig(loadConfig());
 * ```
 */
export const printConfig = (config: Config): void => {
  appendStyledLines(buildConfigLines(config));
};

/**
 * Prints a numbered model picker list for `/set advisor|agent`.
 *
 * @param models - Available model names.
 * @param label - Role label in the header.
 */
export const printModels = (models: string[], label: string): void => {
  appendStyledLines(buildModelsLines(models, label), {
    leadingBlank: true,
    trailingBlank: true,
  });
};

/**
 * Prints local skill names for `/skills list`.
 *
 * @param names - Skill basenames.
 */
export const printSkills = (names: string[]): void => {
  appendStyledLines(buildSkillsLines(names), {
    leadingBlank: true,
    trailingBlank: true,
  });
};

/**
 * Prints stored memory topics/rules for `/memory show`.
 *
 * @param entries - Memory entries from the server.
 */
export const printMemory = (entries: MemoryEntry[]): void => {
  appendStyledLines(buildMemoryLines(entries), {
    leadingBlank: true,
    trailingBlank: true,
  });
};
