/**
 * Renders tool schemas into a text prompt block for models without native tool calling.
 *
 * @remarks
 * Ollama's native tool-calling API isn't supported by every model. When a
 * model can't use it (`supportsTools: false` in subagent config), the same
 * {@link ToolSchema} list that would normally be passed to the API is instead
 * rendered into a plain-text block the model reads as part of its system
 * prompt, describing the `<<TOOL>>{...}<<END>>` text format it must emit
 * tool calls in. `subagentMessageBuilder.ts` includes this block only when
 * native tool support is unavailable, since it's a meaningful chunk of
 * prompt tokens the model doesn't need otherwise.
 */

import type { ToolSchema } from "./types.js";

/** Opening marker for a legacy text-mode tool call, e.g. `<<TOOL>>{"tool":"read_file",...}<<END>>`. */
export const TOOL_START = "<<TOOL>>";
/** Closing marker for a legacy text-mode tool call. */
export const TOOL_END = "<<END>>";

/**
 * Formats one argument as a `"key":"<hint>"` placeholder for the prompt's tool listing.
 *
 * @remarks
 * Uses the argument's JSON-schema `description` as the hint when available
 * (e.g. `"path":"<Relative path from workspace root>"`), falling back to
 * `"..."` otherwise. Optional arguments get a trailing `?` in the hint so
 * the model can tell required from optional fields at a glance.
 *
 * @param key - Argument name.
 * @param properties - The tool's full `parameters.properties` map, indexed to find `key`'s schema.
 * @param required - Whether `key` is in the tool's `required` array.
 * @returns A single `"key":"<hint>"` (or `"key":"<hint>?"`) fragment.
 */
const fieldPlaceholder = (
  key: string,
  properties: Record<string, unknown>,
  required: boolean,
): string => {
  const prop = properties[key];
  const description =
    typeof prop === "object" &&
    prop !== null &&
    "description" in prop &&
    typeof (prop as { description?: unknown }).description === "string"
      ? (prop as { description: string }).description
      : null;
  const hint = description ? `<${description}>` : "...";
  return required ? `"${key}":"${hint}"` : `"${key}":"${hint}?"`;
};

/**
 * Renders one tool schema as a single prompt line describing its call shape.
 *
 * @remarks
 * Includes the tool's own description (when non-empty) in parentheses
 * before the call template. For a built-in tool the name alone (`read_file`,
 * `run_command`) is usually self-explanatory; for an MCP tool — especially
 * one from a third-party server with a terse or generic name — the
 * description is often the only signal the model has for deciding whether
 * the tool applies to the task at hand, so dropping it here would leave the
 * model guessing purely from the name and argument list.
 *
 * @param schema - The tool schema to render.
 * @returns A line like `- edit_file (Replaces text in a file.): {"tool":"edit_file","path":"<...>","old":"<...>"}`.
 *
 * @example
 * ```ts
 * schemaToPromptLine(readFileTool.schema);
 * '- read_file (Read the full content of a file from the workspace.): {"tool":"read_file","path":"<Relative path from workspace root>"}'
 * ```
 */
export const schemaToPromptLine = (schema: ToolSchema): string => {
  const { name, description, parameters } = schema.function;
  const fields = Object.keys(parameters.properties)
    .map((key) =>
      fieldPlaceholder(
        key,
        parameters.properties,
        parameters.required.includes(key),
      ),
    )
    .join(",");
  const descriptionSuffix = description ? ` (${description})` : "";
  return `- ${name}${descriptionSuffix}: {"tool":"${name}",${fields}}`;
};

/** Worked example of a multi-line `edit_file` call with properly escaped newlines. */
const EDIT_FILE_EXAMPLE = `${TOOL_START}{"tool":"edit_file","path":"src/App.tsx","old":"export default App;","new":"export default App;\\n\\nexport function TimeDisplay() { return null; }"}${TOOL_END}`;

/** Worked example of a multi-line `write_file` call with properly escaped newlines. */
const WRITE_FILE_EXAMPLE = `${TOOL_START}{"tool":"write_file","path":"src/Clock.tsx","content":"import React from 'react';\\n\\nexport function Clock() {\\n  return <div />;\\n}\\n"}${TOOL_END}`;

/**
 * Builds the full text-mode tool-calling instruction block for models without native tool support.
 *
 * @remarks
 * Includes the wire format, strict JSON rules (no markdown fences, no
 * template literals, real newlines must be escaped as `\n`), the rendered
 * tool listing, and two worked multi-line examples. This is the single
 * biggest chunk of prompt text `subagentMessageBuilder.ts` injects — it's
 * only included when `supportsTools` is false, since native tool-calling
 * models don't need to be taught the text format at all.
 *
 * @param schemas - Tool schemas to describe (from {@link "./registry.js".getToolSchemas | getToolSchemas}).
 * @returns The complete instruction block, ready to insert into a system prompt.
 */
export const buildLegacyToolBlock = (schemas: ToolSchema[]): string =>
  [
    "[TOOL FORMAT]",
    `${TOOL_START}{"tool":"<name>", ...fields...}${TOOL_END}`,
    "One tool per turn. The entire tool call must be a single line of valid JSON.",
    "Field values must be the literal content itself — not a description, not a placeholder like [file content here].",
    "Values are plain JSON strings, never code: no backticks, no template literals, no ${...} interpolation, and no function calls like readFile(...). Nothing in a field is evaluated.",
    "Do NOT wrap file content in markdown code fences (``` or ```tsx). Put the raw file content only.",
    'Use double quotes for strings. Escape every newline as \\n and every quote as \\" — never press Enter inside the JSON, so real line breaks must become \\n.',
    "To reuse existing file content, read_file first, then paste the literal text. Use edit_file to change part of a file; use write_file only with the complete final content.",
    "Tools:",
    ...schemas.map(schemaToPromptLine),
    "",
    "Example write_file with literal multi-line content (one line, newlines escaped):",
    WRITE_FILE_EXAMPLE,
    "",
    "Example edit_file with literal multi-line content:",
    EDIT_FILE_EXAMPLE,
  ].join("\n");
