/**
 * UI label formatting for TokenSave (MCP) tool calls.
 *
 * @remarks
 * TokenSave tools (`tokensave_search`, `tokensave_context`, etc.) are
 * discovered dynamically from an MCP server, so their arguments aren't known
 * at compile time the way file-tool arguments are. This module extracts a
 * human-readable "target" (the search query, the symbol name, etc.) from
 * each call's raw arguments and formats it into the three label variants the
 * UI needs: a scrollback history line, a short prefix label, and a
 * spinner/activity message.
 */

/** Maximum characters shown in a formatted target before truncating with an ellipsis. */
const MAX_LABEL_LEN = 60;

/** Truncates a label to {@link MAX_LABEL_LEN} characters, appending `…` if cut. */
const truncate = (value: string): string =>
  value.length > MAX_LABEL_LEN ? `${value.slice(0, MAX_LABEL_LEN)}…` : value;

/**
 * Returns the first non-empty string value found among the given argument keys.
 *
 * @remarks
 * Different TokenSave tools name their primary argument differently (`query`
 * vs `q`, `symbol` vs `name` vs `function`); this checks each candidate key
 * in order and returns the first one with a non-empty trimmed value.
 *
 * @param args - Raw tool call arguments.
 * @param keys - Candidate argument names to check, in priority order.
 * @returns The first non-empty value found, or `""` if none of the keys are present.
 */
const firstString = (args: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = String(args[key] ?? "").trim();
    if (value.length > 0) {
      return value;
    }
  }
  return "";
};

/**
 * Extracts a display-ready target string for a TokenSave tool call, e.g. for `Search(target)` in scrollback.
 *
 * @param toolName - TokenSave tool name, e.g. `"tokensave_search"`.
 * @param args - Raw arguments passed to the tool.
 * @returns The truncated target string (query, symbol, or file path depending on tool), or a
 *   generic fallback (`"codebase"`, `"context"`, `"symbol"`, `"status"`) if no matching argument is set.
 *
 * @example
 * ```ts
 * tokenSaveHistoryTarget("tokensave_search", { query: "auth middleware" });
 * "auth middleware"
 * ```
 */
export const tokenSaveHistoryTarget = (
  toolName: string,
  args: Record<string, unknown>,
): string => {
  switch (toolName) {
    case "tokensave_search":
      return truncate(firstString(args, ["query", "q"]) || "codebase");
    case "tokensave_context":
      return truncate(
        firstString(args, ["symbol", "path", "file", "name"]) || "context",
      );
    case "tokensave_callers":
    case "tokensave_callees":
    case "tokensave_impact":
      return truncate(
        firstString(args, ["symbol", "name", "function"]) || "symbol",
      );
    case "tokensave_status":
      return "status";
    default:
      return toolName;
  }
};

/**
 * Returns the short label prefix shown before a TokenSave call's target in scrollback.
 *
 * @param toolName - TokenSave tool name, e.g. `"tokensave_search"`.
 * @returns A short capitalized label (`"Search"`, `"Callers"`, `"Index"`, etc.),
 *   or `"TokenSave"` for unrecognized tool names.
 */
export const tokenSaveHistoryLabel = (toolName: string): string => {
  switch (toolName) {
    case "tokensave_search":
      return "Search";
    case "tokensave_context":
      return "Context";
    case "tokensave_callers":
      return "Callers";
    case "tokensave_callees":
      return "Callees";
    case "tokensave_impact":
      return "Impact";
    case "tokensave_status":
      return "Index";
    default:
      return "TokenSave";
  }
};

/**
 * Builds the spinner/task-board activity message shown while a TokenSave call is in flight.
 *
 * @param toolName - TokenSave tool name, e.g. `"tokensave_search"`.
 * @param args - Raw arguments, used to derive the target via {@link tokenSaveHistoryTarget}.
 * @returns A present-progressive message ending in `"..."`, e.g. `'Searching "auth"...'`.
 */
export const tokenSaveActivityMessage = (
  toolName: string,
  args: Record<string, unknown>,
): string => {
  const target = tokenSaveHistoryTarget(toolName, args);
  switch (toolName) {
    case "tokensave_search":
      return target === "codebase"
        ? "Searching codebase..."
        : `Searching "${target}"...`;
    case "tokensave_context":
      return `Loading context for ${target}...`;
    case "tokensave_callers":
      return `Finding callers of ${target}...`;
    case "tokensave_callees":
      return `Finding callees of ${target}...`;
    case "tokensave_impact":
      return `Analyzing impact of ${target}...`;
    case "tokensave_status":
      return "Checking code index...";
    default:
      return `Running ${toolName}...`;
  }
};

/**
 * Returns the same activity message as {@link tokenSaveActivityMessage} without the trailing ellipsis.
 *
 * @remarks
 * Some UI surfaces (proxy working-spinners) render their own progress
 * indicator alongside the label and don't want a redundant `"..."` suffix.
 *
 * @param toolName - TokenSave tool name.
 * @param args - Raw arguments, forwarded to {@link tokenSaveActivityMessage}.
 * @returns The activity message with any trailing `"..."` stripped.
 */
export const tokenSaveWorkingLabel = (
  toolName: string,
  args: Record<string, unknown>,
): string => {
  const message = tokenSaveActivityMessage(toolName, args);
  return message.endsWith("...") ? message.slice(0, -3) : message;
};
