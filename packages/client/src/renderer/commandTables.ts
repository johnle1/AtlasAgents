/**
 * Themed table/list printers for `/config`, `/set` model pick, skills, memory.
 *
 * @remarks
 * Builders return ANSI line arrays; `print*` wrappers push them through
 * {@link appendStyledLines} with consistent vertical spacing.
 */

import type { Config } from "../config/index.js";
import type { MemoryEntry } from "../connection/index.js";
import { getTheme } from "../theme/themeManager.js";
import { THEMES } from "../theme/themes.js";
import { appendStyledLines } from "./sink.js";
import type { ModelGroup, FlatModelEntry, CurrentModelSelection } from "./types.js";
import type { CommandEntry } from "../ui/commandCatalog.js";
import { COMMAND_CATALOG } from "../ui/commandCatalog.js";

/**
 * Whether two Ollama model tags refer to the same model, tolerating the
 * common bare-name-vs-`:latest` mismatch (e.g. `"gemma3"` and
 * `"gemma3:latest"`), mirroring {@link matchRunningModel}'s normalization.
 */
const modelTagsMatch = (tagA: string, tagB: string): boolean => {
  if (tagA === tagB) return true;
  const withLatest = (tag: string): string =>
    tag.includes(":") ? tag : `${tag}:latest`;
  return withLatest(tagA) === withLatest(tagB);
};

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
    `  ${theme.textAccent}agent model${theme.reset}      ${config.subagentModel || theme.textSecondary + "(not set)" + theme.reset}`,
    `  ${theme.textAccent}subagent model${theme.reset}   ${config.subsubagentModel || theme.textSecondary + "(not set)" + theme.reset}`,
    `  ${theme.textAccent}subagent cap${theme.reset}    ${config.subagentCap} (/subagent cap, ::max for no cap)`,
    `  ${theme.textAccent}ui.theme${theme.reset}       ${resolvedThemeName} (${config.ui.theme})`,
    `  ${theme.textAccent}show think${theme.reset}     ${config.showThinkOutput ? "on" : "off"} (/think on|off)`,
    `  ${theme.textAccent}show spinner${theme.reset}   ${spinnerState}`,
  ];
};

/**
 * Builds a 1-based numbered model list for agent/subagent picking.
 *
 * @param models - Model name strings from the server.
 * @param label - Role label in the header (`"agent"` / `"subagent"`).
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
 * Builds a provider-grouped, continuously-numbered model list for agent/subagent
 * picking, plus the flat entries the picker maps a chosen number back onto.
 *
 * @remarks
 * Numbering runs continuously across groups (1..N) so the existing numbered
 * {@link appendStyledLines} / choice prompt keeps working unchanged — only the
 * list layout is new. Groups with zero models (including provider errors) are
 * skipped so unreachable providers don't clutter the list; their `error` (if
 * any) is not otherwise surfaced here.
 *
 * @param groups - Per-provider model lists from `providers.listModels`.
 * @param label - Role label in the header (`"agent"` / `"subagent"`).
 * @param current - Currently-configured agent/subagent (provider, model), if
 *   known, so matching rows can be marked in the list.
 * @returns Styled lines plus the flat (provider, model) list indexed 0..N-1.
 */
export const buildGroupedModelsLines = (
  groups: ModelGroup[],
  label: string,
  current?: CurrentModelSelection,
): { lines: string[]; entries: FlatModelEntry[] } => {
  const theme = getTheme();
  const lines = [
    `${theme.textBold}  Available models for ${label}:${theme.reset}`,
    "",
  ];
  const entries: FlatModelEntry[] = [];

  for (const group of groups) {
    if (group.models.length === 0) continue;

    lines.push(`  ${theme.textAccent}${group.provider}${theme.reset}`);
    for (const model of group.models) {
      entries.push({ provider: group.provider, model });

      const marks: string[] = [];
      const isAgent =
        current?.agent?.provider === group.provider &&
        modelTagsMatch(current.agent.model, model);
      const isSubagent =
        current?.subagent?.provider === group.provider &&
        modelTagsMatch(current.subagent.model, model);
      if (isAgent && isSubagent) {
        marks.push("current agent + subagent");
      } else if (isAgent) {
        marks.push("current agent");
      } else if (isSubagent) {
        marks.push("current subagent");
      }
      const marker =
        marks.length > 0
          ? `  ${theme.success}← ${marks.join(", ")}${theme.reset}`
          : "";

      lines.push(
        `  ${theme.warning}${String(entries.length).padStart(3)}${theme.reset}  ${model}${marker}`,
      );
    }
  }

  lines.push("");
  return { lines, entries };
};

/**
 * Prints a provider-grouped numbered model picker list for `/set agent|subagent`.
 *
 * @param groups - Per-provider model lists from `providers.listModels`.
 * @param label - Role label in the header.
 * @param current - Currently-configured agent/subagent (provider, model), if
 *   known, so matching rows show `← current agent`, `← current subagent`, or
 *   `← current agent + subagent` when the same model serves both roles.
 * @returns Flat (provider, model) entries in display order, for mapping a
 *   chosen number back to a selection.
 */
export const printGroupedModels = (
  groups: ModelGroup[],
  label: string,
  current?: CurrentModelSelection,
): FlatModelEntry[] => {
  const { lines, entries } = buildGroupedModelsLines(groups, label, current);
  appendStyledLines(lines, { leadingBlank: true, trailingBlank: true });
  return entries;
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
 * Builds themed lines listing configured providers and which role (if any)
 * each one currently serves.
 *
 * @param providers - Provider map from `providers.list` (name → connection info).
 * @param agentProvider - Provider name currently serving the agent role.
 * @param subagentProvider - Provider name currently serving the subagent role.
 * @returns Styled lines (empty-state when no providers configured).
 */
const buildProvidersLines = (
  providers: Record<string, { baseUrl?: string }>,
  agentProvider: string,
  subagentProvider: string,
): string[] => {
  const theme = getTheme();
  const names = Object.keys(providers);

  if (names.length === 0) {
    return [
      `${theme.textSecondary}  No providers configured.${theme.reset}`,
      "",
    ];
  }

  const lines = [`${theme.textBold}  Providers:${theme.reset}`, ""];

  for (const name of names) {
    const roles = [
      name === agentProvider ? "agent" : null,
      name === subagentProvider ? "subagent" : null,
    ]
      .filter((role): role is string => role !== null)
      .join(", ");

    const baseUrl = providers[name]?.baseUrl;
    const baseUrlSuffix = baseUrl
      ? ` ${theme.textSecondary}(${baseUrl})${theme.reset}`
      : "";
    const roleSuffix = roles
      ? ` ${theme.textAccent}[${roles}]${theme.reset}`
      : "";

    lines.push(
      `  ${theme.textAccent}•${theme.reset} ${name}${baseUrlSuffix}${roleSuffix}`,
    );
  }

  lines.push("");
  return lines;
};

/**
 * Prints configured providers and their current agent/subagent assignment
 * for `/providers list`.
 *
 * @param providers - Provider map from `providers.list`.
 * @param agentProvider - Provider name currently serving the agent role.
 * @param subagentProvider - Provider name currently serving the subagent role.
 */
export const printProviders = (
  providers: Record<string, { baseUrl?: string }>,
  agentProvider: string,
  subagentProvider: string,
): void => {
  appendStyledLines(
    buildProvidersLines(providers, agentProvider, subagentProvider),
    { leadingBlank: true, trailingBlank: true },
  );
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
 * Prints a numbered model picker list for `/set agent|subagent`.
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

/**
 * Section order for `/help`. Commands that do not match a rule fall through
 * to `"Other"` so a new catalog entry cannot silently vanish from the screen.
 */
const HELP_GROUP_ORDER = [
  "Connection",
  "Models",
  "Providers",
  "Agent",
  "Config",
  "Skills",
  "Memory",
  "Workspace",
  "UI",
  "Session",
  "Other",
] as const;

/**
 * Maps a catalog command to a `/help` section.
 *
 * @param command - Catalog `command` field (e.g. `"/models pull"`).
 * @returns A section title from {@link HELP_GROUP_ORDER}.
 */
const helpGroupFor = (command: string): (typeof HELP_GROUP_ORDER)[number] => {
  if (
    command.startsWith("/set password") ||
    command.startsWith("/set server") ||
    command.startsWith("/set port")
  ) {
    return "Connection";
  }
  if (
    command.startsWith("/set agent") ||
    command.startsWith("/set subagent") ||
    command.startsWith("/models")
  ) {
    return "Models";
  }
  if (command.startsWith("/providers")) return "Providers";
  if (command.startsWith("/agent")) return "Agent";
  if (command === "/config") return "Config";
  if (command.startsWith("/skills")) return "Skills";
  if (command.startsWith("/memory")) return "Memory";
  if (command.startsWith("/workspace") || command === "/cwd") return "Workspace";
  if (
    command.startsWith("/theme") ||
    command.startsWith("/debug") ||
    command.startsWith("/think") ||
    command.startsWith("/spinner") ||
    command.startsWith("/notify")
  ) {
    return "UI";
  }
  if (
    command === "/new" ||
    command === "/explore" ||
    command === "/help" ||
    command === "/clear" ||
    command === "/exit"
  ) {
    return "Session";
  }
  return "Other";
};

/**
 * Builds themed `/help` lines from a command catalog.
 *
 * @remarks
 * Every catalog entry appears exactly once, grouped under section headers
 * (Models, Providers, Session, UI, …). Using the catalog as input — rather
 * than a hard-coded string — keeps `/help` in lockstep with autocomplete.
 *
 * @param catalog - Command entries to render (normally {@link COMMAND_CATALOG}).
 * @returns Styled lines: header, group titles, and one row per command.
 *
 * @example
 * ```ts
 * const lines = buildHelpLines(COMMAND_CATALOG);
 * ```
 */
export const buildHelpLines = (catalog: CommandEntry[]): string[] => {
  const theme = getTheme();
  const grouped = new Map<string, CommandEntry[]>();

  for (const entry of catalog) {
    const group = helpGroupFor(entry.command);
    const existing = grouped.get(group);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(group, [entry]);
    }
  }

  const displayOf = (entry: CommandEntry): string =>
    entry.label ?? entry.command;
  const columnWidth = catalog.reduce(
    (width, entry) => Math.max(width, displayOf(entry).length),
    0,
  );

  const lines = [
    `${theme.textBold}  Commands${theme.reset}`,
    `${theme.textSecondary}  ${"─".repeat(34)}${theme.reset}`,
  ];

  for (const title of HELP_GROUP_ORDER) {
    const entries = grouped.get(title);
    if (!entries || entries.length === 0) continue;

    lines.push("");
    lines.push(`  ${theme.textAccent}${title}${theme.reset}`);
    for (const entry of entries) {
      const display = displayOf(entry).padEnd(columnWidth);
      lines.push(
        `  ${theme.textBold}${display}${theme.reset}  ${theme.textSecondary}${entry.description}${theme.reset}`,
      );
    }
  }

  return lines;
};

/**
 * Prints the full slash-command help screen to scrollback.
 *
 * @remarks
 * Invoked by `/help`. Renders {@link COMMAND_CATALOG} via {@link buildHelpLines}.
 */
export const printHelp = (): void => {
  appendStyledLines(buildHelpLines(COMMAND_CATALOG), {
    leadingBlank: true,
    trailingBlank: true,
  });
};
