/**
 * Type definitions for terminal rendering and output formatting.
 *
 * @remarks
 * This module consolidates all types used across the renderer package,
 * including display configurations for shell commands, file operations,
 * directory listings, and model selection interfaces. Centralizing these
 * types makes them easier to discover and reuse across the CLI.
 */

/**
 * Classification of a shell command for approval and display purposes.
 *
 * @remarks
 * Commands are categorized by risk level to determine display styling and
 * approval requirements:
 * - `safe` — auto-approved read-only style commands (ls, cat, grep, etc.)
 * - `cautious` — unknown; requires user confirmation before execution
 * - `dangerous` — destructive tokens; requires confirm + warning (rm, reset, etc.)
 * - `background` — detached long-running spawn (npm install, etc.)
 */
export type BashClass = "safe" | "cautious" | "dangerous" | "background";

/**
 * Single entry in a directory listing for display to the user.
 *
 * @remarks
 * Represents a file or directory in a listing printed to scrollback history.
 * Used by {@link printListDirEntries} to render indented directory children
 * after an expand (`ctrl+o`) action. Directories get an expand hint; files
 * get a separator; unreadable entries show an error icon.
 *
 * @example
 * ```ts
 * const entries: DirEntry[] = [
 *   { name: "package.json", isDirectory: false },
 *   { name: "src", isDirectory: true },
 *   { name: ".git", isDirectory: true, noRead: true }
 * ];
 * ```
 */
export type DirEntry = {
  /** Basename of the file or directory (no path separators). */
  name: string;

  /** `true` when this entry is a directory (displays expand hint). */
  isDirectory: boolean;

  /**
   * When `true`, show an error `!` icon instead of the normal glyph
   * indicating the entry is unreadable (permission denied, etc.).
   */
  noRead?: boolean;
};

/**
 * One provider's model list as returned by the server's `providers.listModels` route.
 *
 * @remarks
 * Used by model picker UI to group models by their provider. Groups with
 * zero models (including those with fetch errors) are skipped in display.
 * The `error` field (if present) indicates why the provider list failed
 * to load, but it's not surfaced in the UI — only the availability of
 * models matters.
 *
 * @example
 * ```ts
 * const groups: ModelGroup[] = [
 *   { provider: "ollama", models: ["gemma3:27b", "llama3:70b"] },
 *   { provider: "vllm", models: [], error: "Connection refused" }
 * ];
 * ```
 */
export type ModelGroup = {
  /** Provider name (e.g., "ollama", "vllm", "openai"). */
  provider: string;

  /** List of model names available from this provider. */
  models: string[];

  /** Optional error message if the provider list failed to fetch. */
  error?: string;
};

/**
 * Currently-configured (provider, model) pair for the agent and/or subagent
 * role, used to mark matching rows in the `/set agent|subagent` picker.
 *
 * @remarks
 * Either role may be omitted (not yet configured). Selecting the same model
 * for both roles is valid and is the cheapest VRAM configuration — Ollama
 * loads one shared instance rather than two — so the picker marks a row that
 * matches both roles distinctly from a row matching only one.
 */
export type CurrentModelSelection = {
  agent?: { provider: string; model: string };
  subagent?: { provider: string; model: string };
};

/**
 * One flat, continuously-numbered model picker row — a (provider, model) pair.
 *
 * @remarks
 * Used alongside {@link ModelGroup} for provider-grouped model selection.
 * The picker displays models grouped by provider, but numbers them continuously
 * (1..N across all groups) so the existing numbered choice prompt works unchanged.
 * When a user selects a number, it maps back to one of these entries to determine
 * which provider and model were chosen.
 *
 * @example
 * ```ts
 * const entries: FlatModelEntry[] = [
 *   { provider: "ollama", model: "gemma3:27b" },
 *   { provider: "ollama", model: "llama3:70b" },
 *   { provider: "vllm", model: "mistral:7b" }
 * ];
 * // User selects 2 → { provider: "ollama", model: "llama3:70b" }
 * ```
 */
export type FlatModelEntry = {
  /** Provider name the model belongs to. */
  provider: string;

  /** Model name (displayed in picker). */
  model: string;
};
