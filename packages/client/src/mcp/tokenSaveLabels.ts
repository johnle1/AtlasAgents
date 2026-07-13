const MAX_LABEL_LEN = 60;

const truncate = (value: string): string =>
  value.length > MAX_LABEL_LEN ? `${value.slice(0, MAX_LABEL_LEN)}…` : value;

const firstString = (args: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = String(args[key] ?? "").trim();
    if (value.length > 0) {
      return value;
    }
  }
  return "";
};

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
      return truncate(firstString(args, ["symbol", "name", "function"]) || "symbol");
    case "tokensave_status":
      return "status";
    default:
      return toolName;
  }
};

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

export const tokenSaveWorkingLabel = (
  toolName: string,
  args: Record<string, unknown>,
): string => {
  const target = tokenSaveHistoryTarget(toolName, args);
  switch (toolName) {
    case "tokensave_search":
      return target === "codebase"
        ? "Searching codebase"
        : `Searching ${target}`;
    case "tokensave_context":
      return `Loading context for ${target}`;
    case "tokensave_callers":
      return `Finding callers of ${target}`;
    case "tokensave_callees":
      return `Finding callees of ${target}`;
    case "tokensave_impact":
      return `Analyzing impact of ${target}`;
    case "tokensave_status":
      return "Checking code index";
    default:
      return toolName.length > 0 ? `TokenSave ${toolName}` : "TokenSave";
  }
};
