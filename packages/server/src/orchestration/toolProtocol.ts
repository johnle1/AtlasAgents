/**
 * Legacy text-protocol helpers and shared types for agent tool calling.
 *
 * @remarks
 * Provides utilities for parsing tool calls from subagent responses, extracting thinking
 * blocks, and recovering malformed tool calls. Supports both legacy text protocol
 * and native Ollama tool_calls. Includes functions for stripping markdown fences,
 * validating required fields, and recovering finish tool calls from think blocks.
 */

import type { ToolHandler } from "./tools/types.js";
export { TOOL_START, TOOL_END } from "./tools/promptText.js";
export { buildLegacyToolBlock } from "./tools/promptText.js";

/**
 * Purpose classification for run_command tool calls.
 *
 * @remarks
 * Used to classify shell commands by their intended purpose: setup (one-time
 * environment preparation), verify (test/validation commands), or run-project
 * (indefinite processes like dev servers).
 */
export type CommandPurpose = "setup" | "verify" | "run-project";

/**
 * Normalized tool call shape used by Agent.run() for both protocols.
 *
 * @remarks
 * Represents a parsed tool call with the tool name and arguments. Used by both
 * legacy text protocol and native Ollama tool_calls.
 */
export type ParsedToolCall = {
  /** The name of the tool to call */
  name: string;
  /** The arguments to pass to the tool */
  args: Record<string, unknown>;
};

/**
 * Tag name for subagent thinking blocks, shared with {@link THINKING_TAG_OPEN},
 * {@link THINKING_TAG_CLOSE}, and the incremental think-tag scanner in
 * `thinkStream.ts` so both agree on what to look for.
 */
export const THINK_BLOCK = "redacted_thinking";

/** Opening tag for thinking blocks in subagent responses */
export const THINKING_TAG_OPEN = `<${THINK_BLOCK}>`;

/** Closing tag for thinking blocks in subagent responses */
export const THINKING_TAG_CLOSE = `</${THINK_BLOCK}>`;

const THINKING_RE = new RegExp(
  `<${THINK_BLOCK}>([\\s\\S]*?)<\\/${THINK_BLOCK}>`,
  "gi",
);

/**
 * Extracts the content of the first thinking block from a response.
 *
 * @remarks
 * Uses regex to find the first thinking block and returns its trimmed content.
 * Resets the regex lastIndex after extraction to enable re-use.
 *
 * @param response - The subagent response text
 *
 * @returns The thinking block content, or null if not found
 */
export const extractThinking = (response: string): string | null => {
  const match = THINKING_RE.exec(response);
  THINKING_RE.lastIndex = 0;
  return match?.[1]?.trim() ?? null;
};

/**
 * Removes all thinking blocks from a response.
 *
 * @remarks
 * Uses regex to remove all thinking block tags and their content from the response.
 * Returns the cleaned response with trailing whitespace trimmed.
 *
 * @param response - The subagent response text
 *
 * @returns Response with thinking blocks removed
 */
export const stripThinking = (response: string): string =>
  response.replace(THINKING_RE, "").trim();

/**
 * Removes markdown code-fence lines from think blocks and command-plan sections.
 *
 * @remarks
 * Filters out lines that start with markdown code fence markers (```), which
 * the model sometimes adds around multi-line content. Returns the cleaned text.
 *
 * @param text - The text to strip fences from
 *
 * @returns Text with markdown fence lines removed
 */
export const stripMarkdownFencesFromText = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n")
    .trim();

/**
 * Behavioral rules shared by native and legacy agent paths.
 *
 * @remarks
 * System prompt instructions for the agent that define how to structure think
 * blocks, when to use specific fields (purpose, exits), and how to call tools.
 * Enforces safety rules like requiring background: true for run-project commands
 * and requiring verification before finish.
 */
export const AGENT_RULES = `
You are an expert software engineer working inside a coding agent on a real file system.

Before every tool call, think inside a ${THINKING_TAG_OPEN} block using:
  know:    what you already know (use the session snapshot for stack and commands)
  need:    what is still missing
  action:  tool name only, optionally plus a short target (e.g. "finish" or "read_file package.json") — never "none", never tool arguments
  risk:    what could go wrong
  verify:  how you know it worked
  purpose: [ONLY when action is run_command: setup | verify | run-project — otherwise omit this line]
  exits:   [ONLY when action is run_command: yes | no — otherwise omit this line]

The first think block of each task must also include:
  setup commands:   [copy or adapt from [Agent command plan] above — one command per line, no markdown fences]
  verify commands:  [copy or adapt from [Agent command plan] — use "none" if empty]
  off-limits (run-project): [copy or adapt from [Agent command plan] — background only]

Example (plain lines only — never wrap commands in markdown code fences):
  setup commands: npm install --save-dev jest @testing-library/react
  verify commands: none
  off-limits (run-project): npm run dev

Rules:
- Call exactly one tool per turn, then stop. Thinking alone does not complete the turn — you must also emit the real tool call.
- Never call a tool without a preceding ${THINKING_TAG_OPEN} block.
- Never use markdown code fences inside think blocks.
- action must name a real tool (read_file, write_file, edit_file, run_command, escalate, finish). Never write action: none.
- Do NOT put tool arguments in the action line. Arguments belong only in the tool call (function call or <<TOOL>> JSON).
- Omit purpose and exits unless action is run_command. Never write purpose: none or exits: yes for finish/read_file/write_file/edit_file/escalate — those fields do not apply.
- When setup is already done and the subtask needs no further file or command work, call the finish tool with a short summary (do not only write action: finish in the think block).
- read_file a path before you may edit_file it on the same path in this task.
- write_file only for new files or full rewrites.
- run-project commands require background: true or they will be blocked.
- Before finish, re-read files you wrote or run a verify command that exits 0.
- If blocked, call escalate with a clear reason instead of guessing.

Tool definitions are provided separately (function schemas or legacy tool format).
`.trim();

const TOOL_BLOCK_REGEX = /<<TOOL>>([\s\S]*?)<<END>>/g;

/**
 * Validates that all required fields are present and non-empty in tool arguments.
 *
 * @remarks
 * Checks each required field in the schema against the provided arguments.
 * Returns false if any required field is missing, null, or empty (except content
 * which can be empty). Special case for edit_file: old field cannot be empty.
 *
 * @param schema - The tool handler schema
 * @param args - The arguments to validate
 *
 * @returns True if all required fields are valid
 */
const validateRequiredFields = (
  schema: ToolHandler["schema"],
  args: Record<string, unknown>,
): boolean => {
  for (const field of schema.function.parameters.required) {
    const value = args[field];
    if (value === undefined || value === null) {
      return false;
    }
    if (
      typeof value === "string" &&
      value.length === 0 &&
      field !== "content"
    ) {
      return false;
    }
  }
  if (
    schema.function.name === "edit_file" &&
    typeof args.old === "string" &&
    args.old.length === 0
  ) {
    return false;
  }
  return true;
};

/** Fields that commonly carry multi-line code the model may fence or mis-escape */
const CONTENT_BEARING_FIELDS = new Set(["content", "old", "new"]);

/**
 * Removes a wrapping markdown code fence (```lang ... ```) if the model wrapped
 * literal file content in one. Also strips a lone opening fence line when the
 * closing fence is missing. Returns the value unchanged when no fence is found.
 *
 * @remarks
 * The model sometimes wraps file content in markdown code fences, which breaks
 * JSON parsing. This function detects and removes those fences, handling both
 * complete fences and incomplete (opening only) fences.
 *
 * @param value - The value to strip fences from
 *
 * @returns Value with markdown fence removed, or unchanged if no fence found
 */
export const stripMarkdownFence = (value: string): string => {
  const trimmed = value.trim();
  const fullMatch = /^\s*```[^\n]*\n([\s\S]*?)\n?```[ \t]*$/.exec(trimmed);
  if (fullMatch) {
    return fullMatch[1];
  }
  const openOnly = /^\s*```[^\n]*\n([\s\S]+)$/.exec(trimmed);
  if (openOnly && !/```/.test(openOnly[1])) {
    return openOnly[1];
  }
  return value;
};

/**
 * Applies standard JSON string escape sequences to a raw extracted substring.
 *
 * @remarks
 * Replaces JSON escape sequences (\n, \t, \uXXXX, etc.) with their actual
 * character values. Used when recovering malformed tool calls where string
 * values were extracted positionally.
 *
 * @param raw - The raw string with escape sequences
 *
 * @returns Unescaped string
 */
const unescapeJsonStringLiteral = (raw: string): string =>
  raw.replace(
    /\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g,
    (_match, escapeBody: string) => {
      switch (escapeBody[0]) {
        case '"':
          return '"';
        case "\\":
          return "\\";
        case "/":
          return "/";
        case "b":
          return "\b";
        case "f":
          return "\f";
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "u":
          return String.fromCharCode(parseInt(escapeBody.slice(1), 16));
        default:
          return escapeBody;
      }
    },
  );

/**
 * Best-effort recovery for tool blocks that fail strict JSON.parse.
 *
 * @remarks
 * Recovers tool calls that fail strict JSON.parse, typically because the model
 * put literal newlines or a markdown fence inside a string value. Reconstructs
 * fields positionally using the known tool schema so that embedded quotes,
 * newlines, and fences no longer break parsing. Returns null when the block
 * cannot be safely recovered so the caller treats it as malformed.
 *
 * @param raw - The raw tool block string
 * @param registry - The tool handler registry
 *
 * @returns Parsed tool call, or null if recovery failed
 */
const recoverMalformedToolCall = (
  raw: string,
  registry: ToolHandler[],
): ParsedToolCall | null => {
  const toolNameMatch = /"tool"\s*:\s*"([A-Za-z0-9_]+)"/.exec(raw);
  if (!toolNameMatch) {
    return null;
  }
  const toolName = toolNameMatch[1];
  const handler = registry.find(
    (entry) => entry.schema.function.name === toolName,
  );
  if (!handler) {
    return null;
  }

  const fieldKeys = Object.keys(handler.schema.function.parameters.properties);

  const stringMarkers = fieldKeys
    .map((key) => {
      const marker = new RegExp(`"${key}"\\s*:\s*"`).exec(raw);
      return marker
        ? {
            key,
            start: marker.index,
            valueStart: marker.index + marker[0].length,
          }
        : null;
    })
    .filter(
      (marker): marker is { key: string; start: number; valueStart: number } =>
        marker !== null,
    )
    .sort((a, b) => a.valueStart - b.valueStart);

  const args: Record<string, unknown> = {};
  for (let index = 0; index < stringMarkers.length; index += 1) {
    const current = stringMarkers[index];
    const next = stringMarkers[index + 1];

    let rawValue: string;
    if (next) {
      rawValue = raw
        .slice(current.valueStart, next.start)
        .replace(/"\s*,\s*$/, "");
    } else {
      const tail = raw.slice(current.valueStart);
      const endMatch = /"\s*\}?\s*$/.exec(tail);
      if (!endMatch) {
        return null;
      }
      rawValue = tail.slice(0, endMatch.index);
    }

    let value = unescapeJsonStringLiteral(rawValue);
    if (CONTENT_BEARING_FIELDS.has(current.key)) {
      value = stripMarkdownFence(value);
    }
    args[current.key] = value;
  }

  for (const key of fieldKeys) {
    if (key in args) {
      continue;
    }
    const boolMatch = new RegExp(`"${key}"\\s*:\s*(true|false)`).exec(raw);
    if (boolMatch) {
      args[key] = boolMatch[1] === "true";
    }
  }

  if (!validateRequiredFields(handler.schema, args)) {
    return null;
  }

  return { name: toolName, args };
};

/**
 * Parses a single tool call from JSON string with lenient recovery.
 *
 * @remarks
 * First attempts strict JSON.parse. If that fails, attempts to recover the
 * tool call using position-based parsing. Logs recovered calls for debugging.
 *
 * @param rawJsonString - The raw JSON string to parse
 * @param registry - The tool handler registry
 *
 * @returns Parsed tool call, or null if parsing failed
 */
export const parseAgentToolCall = (
  rawJsonString: string,
  registry: ToolHandler[],
): ParsedToolCall | null => {
  try {
    const parsedObject = JSON.parse(rawJsonString) as Record<string, unknown>;
    const toolName = parsedObject.tool;
    if (typeof toolName !== "string") {
      return null;
    }

    const handler = registry.find(
      (entry) => entry.schema.function.name === toolName,
    );
    if (!handler) {
      return null;
    }

    const { tool: _tool, ...rest } = parsedObject;
    const args = rest as Record<string, unknown>;

    if (!validateRequiredFields(handler.schema, args)) {
      return null;
    }

    return { name: toolName, args };
  } catch {
    const recovered = recoverMalformedToolCall(rawJsonString, registry);
    if (recovered) {
      console.error(
        "[Agent] Recovered malformed tool call via lenient parse:",
        recovered.name,
      );
    }
    return recovered;
  }
};

/**
 * Result type for parsing all tool calls from text.
 *
 * @remarks
 * Contains the parsed tool calls and a flag indicating whether any malformed
 * blocks were encountered.
 */
export type ParseToolCallsResult = {
  /** Array of successfully parsed tool calls */
  calls: ParsedToolCall[];
  /** True if any tool blocks failed to parse */
  hadMalformedBlock: boolean;
};

/**
 * Parses all tool calls from text containing <<TOOL>> blocks.
 *
 * @remarks
 * Uses regex to find all <<TOOL>>...<<END>> blocks and parses each one.
 * Tracks whether any blocks failed to parse for debugging.
 *
 * @param text - The text containing tool blocks
 * @param registry - The tool handler registry
 *
 * @returns Parse result with calls and malformed block flag
 */
export const parseAllToolCalls = (
  text: string,
  registry: ToolHandler[],
): ParseToolCallsResult => {
  const parsedCalls: ParsedToolCall[] = [];
  let hadMalformedBlock = false;
  TOOL_BLOCK_REGEX.lastIndex = 0;
  let regexMatch: RegExpExecArray | null;
  while ((regexMatch = TOOL_BLOCK_REGEX.exec(text)) !== null) {
    const parsedCall = parseAgentToolCall(regexMatch[1].trim(), registry);
    if (parsedCall) {
      parsedCalls.push(parsedCall);
    } else {
      hadMalformedBlock = true;
      console.error(
        "[Agent] Failed to parse tool call JSON:",
        regexMatch[1].slice(0, 200),
      );
    }
  }
  return { calls: parsedCalls, hadMalformedBlock };
};

/**
 * Extracts the first tool call from text containing <<TOOL>> blocks.
 *
 * @remarks
 * Convenience function that parses all tool calls and returns the first one,
 * or null if no tool calls were found.
 *
 * @param text - The text containing tool blocks
 * @param registry - The tool handler registry
 *
 * @returns First parsed tool call, or null if none found
 */
export const extractToolFromText = (
  text: string,
  registry: ToolHandler[],
): ParsedToolCall | null => parseAllToolCalls(text, registry).calls[0] ?? null;

/** Regex pattern matching think block field boundaries */
const THINK_FIELD_BOUNDARY =
  /^\s*(?:know|need|action|risk|verify|purpose|exits|setup\s+commands|verify\s+commands|off-limits)\s*:/im;

/** Regex pattern for pipe-delimited string values */
const PIPE_STRING_RE = /<\|"\|>([\s\S]*?)<\|"\|>/g;

/**
 * Strips wrapping parentheses or braces from a string.
 *
 * @remarks
 * Removes outer { } or ( ) characters if they wrap the entire string.
 * Used when parsing finish arguments that the model may have wrapped.
 *
 * @param raw - The string to strip
 *
 * @returns String without wrapping delimiters
 */
const stripWrappingParensOrBraces = (raw: string): string => {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

/**
 * Extracts pipe-delimited string values from text.
 *
 * @remarks
 * Finds all occurrences of <|"|>value<|"|> patterns and returns
 * the trimmed values. Used for parsing finish arguments in pipe format.
 *
 * @param raw - The text containing pipe-delimited values
 *
 * @returns Array of extracted string values
 */
const extractPipeDelimitedStrings = (raw: string): string[] => {
  const values: string[] = [];
  PIPE_STRING_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PIPE_STRING_RE.exec(raw)) !== null) {
    const value = match[1].trim();
    if (value.length > 0) {
      values.push(value);
    }
  }
  return values;
};

/**
 * Extracts a named pipe-delimited value from text.
 *
 * @remarks
 * Looks for a pattern like "field: <|"|>value<|"|>" and returns the value.
 * Case-insensitive field matching.
 *
 * @param raw - The text containing the named value
 * @param field - The field name to extract
 *
 * @returns The extracted value, or null if not found
 */
const extractNamedPipeValue = (raw: string, field: string): string | null => {
  const pattern = new RegExp(
    `${field}\\s*:\\s*<\\|"\\|>([\\s\\S]*?)<\\|"\\|>`,
    "i",
  );
  const match = pattern.exec(raw);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
};

/**
 * Attempts to parse finish arguments from various JSON formats.
 *
 * @remarks
 * Tries multiple parsing strategies: raw JSON, with wrapping braces removed,
 * and with braces added if missing. Returns null if all attempts fail.
 *
 * @param raw - The raw string to parse
 *
 * @returns Parsed object, or null if parsing failed
 */
const tryParseFinishArgsJson = (
  raw: string,
): Record<string, unknown> | null => {
  const candidates = [raw.trim()];
  const stripped = stripWrappingParensOrBraces(raw);
  if (stripped !== raw.trim()) {
    candidates.push(stripped);
  }
  if (!stripped.startsWith("{")) {
    candidates.push(`{${stripped}}`);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
};

/**
 * Recovers a finish tool call when the model only wrote finish into the think
 * action line (often with invented delimiters) and never emitted a real tool call.
 *
 * @remarks
 * Parses the think block to extract finish arguments from various formats:
 * JSON, pipe-delimited values, or bare strings. Handles multiple argument formats
 * the model might invent. Returns a finish tool call with summary and keyFindings.
 *
 * @param thinkText - The think block text containing the finish action
 *
 * @returns Parsed finish tool call, or null if recovery failed
 */
export const recoverFinishFromThink = (
  thinkText: string,
): ParsedToolCall | null => {
  const actionMatch = /^\s*action:\s*finish\b(.*)$/im.exec(thinkText);
  if (!actionMatch) {
    return null;
  }

  const actionStart = actionMatch.index ?? 0;
  const afterActionHeader = actionStart + actionMatch[0].length;
  const firstLineArgs = actionMatch[1] ?? "";
  const remainder = thinkText.slice(afterActionHeader);
  const boundaryMatch = THINK_FIELD_BOUNDARY.exec(remainder);
  const restArgs = boundaryMatch
    ? remainder.slice(0, boundaryMatch.index)
    : remainder;
  const actionArgsRaw = `${firstLineArgs}${restArgs}`.trim();

  const args: Record<string, unknown> = {};

  const jsonArgs = actionArgsRaw ? tryParseFinishArgsJson(actionArgsRaw) : null;
  if (jsonArgs) {
    if (typeof jsonArgs.summary === "string" && jsonArgs.summary.trim()) {
      args.summary = jsonArgs.summary.trim();
    }
    if (Array.isArray(jsonArgs.keyFindings)) {
      args.keyFindings = jsonArgs.keyFindings
        .map((finding) => String(finding).trim())
        .filter((finding) => finding.length > 0);
    }
  }

  if (!args.summary) {
    const pipeSummary = extractNamedPipeValue(actionArgsRaw, "summary");
    if (pipeSummary) {
      args.summary = pipeSummary;
    }
  }

  if (!args.keyFindings) {
    const keyFindingsMatch = /keyFindings\s*:\s*\[([\s\S]*?)\]/i.exec(
      actionArgsRaw,
    );
    if (keyFindingsMatch) {
      const findings = extractPipeDelimitedStrings(keyFindingsMatch[1]);
      if (findings.length > 0) {
        args.keyFindings = findings;
      }
    }
  }

  if (
    !args.summary &&
    actionArgsRaw.length > 0 &&
    !actionArgsRaw.includes(":")
  ) {
    const bare = stripWrappingParensOrBraces(actionArgsRaw).replace(
      /^["']|["']$/g,
      "",
    );
    if (bare.length > 0) {
      args.summary = bare;
    }
  }

  if (!args.summary) {
    const knowMatch = /^\s*know:\s*(.+)$/im.exec(thinkText);
    const knowText = knowMatch?.[1]?.trim();
    args.summary =
      knowText && knowText.length > 0 ? knowText : "Subtask complete.";
  }

  return { name: "finish", args };
};
