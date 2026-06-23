/**
 * <Summary>
 * What it does:
 *   Defines tool-call markers and streaming parser for Agent.run.
 *
 * How it fits in the system:
 *   Provides the protocol for parsing tool calls from LLM responses.
 *   LLMs output tool calls between TOOL_START and TOOL_END markers.
 *   The streaming parser extracts these tool calls incrementally.
 *
 *   - Agent.run — parses tool calls from LLM responses.
 * </Summary>
 */

/** Marker that begins a tool call block in LLM responses. */
export const TOOL_START = "<<TOOL>>";

/** Marker that ends a tool call block in LLM responses. */
export const TOOL_END = "<<END>>";

/** Maximum number of retries when model outputs markdown instead of tool calls. */
export const MAX_MARKDOWN_RETRIES = 2;

/**
 * <Summary>
 * What it does:
 *   Error message sent to LLM when it outputs markdown instead of tool calls.
 *
 * How it fits in the system:
 *   Used to correct the model when it incorrectly uses code fences
 *   instead of the tool call protocol. Instructs the model to retry
 *   with the correct format.
 *
 *   - Agent.run — sends correction message to model.
 * </Summary>
 */
export const MARKDOWN_CORRECTION_MESSAGE =
  "You printed code or markdown instead of using tool calls. " +
  "Do NOT use markdown code fences (``` or ~~~). " +
  "Do NOT paste full file contents in your reply. " +
  `Use exactly one block: ${TOOL_START}{"tool":"edit_file","path":"...","old":"...","new":"..."}${TOOL_END} ` +
  "(or read_file / write_file / run_command / finish). Retry now with the correct format only.";

/**
 * <Summary>
 * What it does:
 *   Purpose classification for run_command tool calls.
 *
 * How it fits in the system:
 *   Helps the system understand why a command is being run.
 *   "setup" commands prepare the environment.
 *   "verify" commands check that work is correct.
 *   "run-project" commands start dev servers (must be background).
 *
 *   - AgentToolCall — run_command includes purpose field.
 * </Summary>
 */
export type CommandPurpose = "setup" | "verify" | "run-project";

/**
 * <Summary>
 * What it does:
 *   Union type of all tool names available to agents.
 *
 * How it fits in the system:
 *   Defines the complete set of tools that agents can invoke.
 *   Each tool corresponds to a specific capability (file ops, commands, etc.).
 *
 *   - AgentToolCall — tool field must be one of these names.
 * </Summary>
 */
export type AgentToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "run_command"
  | "escalate"
  | "finish";

/**
 * <Summary>
 * What it does:
 *   Discriminated union of all possible tool call structures.
 *
 * How it fits in the system:
 *   Each variant corresponds to a different tool with its specific parameters.
 *   The "tool" field discriminates which variant is being used.
 *   Parsed from LLM responses between TOOL_START and TOOL_END markers.
 *
 *   - Agent.run — executes the parsed tool call.
 * </Summary>
 */
export type AgentToolCall =
  | { tool: "read_file"; path: string }
  | { tool: "write_file"; path: string; content: string }
  | {
      tool: "edit_file";
      path: string;
      old: string;
      new: string;
      replace_all?: boolean;
    }
  | {
      tool: "run_command";
      command: string;
      purpose?: CommandPurpose;
      background?: boolean;
    }
  | { tool: "escalate"; reason: string }
  | { tool: "finish"; summary: string };

/** Internal tag name for thinking blocks (redacted from LLM output). */
const THINK_BLOCK = "redacted_thinking";

/** Opening tag for thinking blocks in LLM responses. */
export const THINKING_TAG_OPEN = `<${THINK_BLOCK}>`;

/** Closing tag for thinking blocks in LLM responses. */
export const THINKING_TAG_CLOSE = `</${THINK_BLOCK}>`;

/** Regular expression to match thinking blocks with their content. */
const THINKING_RE = new RegExp(
  `<${THINK_BLOCK}>([\\s\\S]*?)<\\/${THINK_BLOCK}>`,
  "gi",
);

/**
 * <Summary>
 * What it does:
 *   Extracts the content of the first thinking block from a response.
 *
 * How it does it (step by step):
 *   1. Execute regex to find first thinking block.
 *   2. Reset regex lastIndex for future use.
 *   3. Return trimmed content or null if not found.
 *
 * Parameters:
 *   @param response - The LLM response text to extract from.
 *
 * Returns:
 *   Trimmed thinking content or null if no thinking block found.
 *
 *   - Agent.run — extracts reasoning from LLM responses.
 * </Summary>
 */
export const extractThinking = (response: string): string | null => {
  // Step 1: Execute regex to find first thinking block
  const match = THINKING_RE.exec(response);
  // Step 2: Reset regex lastIndex for future use
  THINKING_RE.lastIndex = 0;
  // Step 3: Return trimmed content or null if not found
  return match?.[1]?.trim() ?? null;
};

/**
 * <Summary>
 * What it does:
 *   Removes all thinking blocks from a response.
 *
 * How it does it (step by step):
 *   1. Replace all thinking block matches with empty string.
 *   2. Trim whitespace from result.
 *
 * Parameters:
 *   @param response - The LLM response text to clean.
 *
 * Returns:
 *   Response text with all thinking blocks removed and trimmed.
 *
 *   - Agent.run — cleans responses before tool extraction.
 * </Summary>
 */
export const stripThinking = (response: string): string => {
  // Step 1-2: Replace all thinking blocks and trim result
  return response.replace(THINKING_RE, "").trim();
};

/**
 * <Summary>
 * What it does:
 *   System instruction prompt that teaches the LLM how to use tools correctly.
 *
 * How it fits in the system:
 *   This is the core protocol document that the LLM receives.
 *   It explains the thinking block format, tool call syntax,
 *   file operation rules, command reasoning requirements,
 *   and verification expectations.
 *
 *   - Agent.run — includes this in the system prompt.
 * </Summary>
 */
export const TOOL_SYSTEM_INSTRUCTION = `
[REASONING RULES]

You are a coding agent on a real file system. Think before every action. Observe every result.

Before EVERY tool call write a ${THINKING_TAG_OPEN} block:
${THINKING_TAG_OPEN}
know:    [what you have confirmed — use the session snapshot for stack and commands]
need:    [what is still unclear]
action:  [exact tool and why]
risk:    [what could go wrong]
verify:  [how you know it worked]
purpose: [run_command only: setup | verify | run-project]
exits:   [run_command only: yes | no]
${THINKING_TAG_CLOSE}

The first think block of each task must also include:
setup commands:   [copy or adapt from [Advisor command plan] above]
verify commands:    [copy or adapt from [Advisor command plan] — exits pass/fail]
off-limits (run-project): [copy or adapt from [Advisor command plan] — background only]

- Never call a tool without a preceding ${THINKING_TAG_OPEN} block
- Never print code blocks or markdown fences in replies
- Output exactly ONE ${TOOL_START}...${TOOL_END} block per turn, then stop
- Paths are relative to the workspace root

[FILE OPERATION RULES]

- read_file before edit_file on the same path in this task
- edit_file for surgical changes: {"tool":"edit_file","path":"...","old":"exact anchor","new":"replacement","replace_all":false}
- old must appear exactly once unless replace_all is true
- write_file only for new files or full rewrites

[COMMAND REASONING RULES]

For run_command include in the think block:
command: [exact string]
purpose: setup | verify | run-project
exits:   yes | no
risk:    [what if non-zero exit]

run_command JSON may include purpose and background:
{"tool":"run_command","command":"...","purpose":"verify"}
{"tool":"run_command","command":"...","purpose":"run-project","background":true}

run-project commands (dev servers) require background: true or they will be blocked.
Use verify commands from [Advisor command plan] in your system prompt.
purpose on run_command JSON overrides list matching when set.

[VERIFICATION RULES]

Before finish you must verify work if you wrote or edited files:

Option 1 — Re-read every file you wrote or edited and confirm the requirement in your think block.
Option 2 — Run a verify command that exits on its own with code 0 (from [Advisor command plan]).

Starting a server is NEVER verification. Servers do not prove correctness.
finish will be blocked without file re-read or successful verify command.

[TOOL FORMAT]

${TOOL_START}{"tool":"<name>", ...fields...}${TOOL_END}

Tools:
- read_file: {"tool":"read_file","path":"relative/path"}
- write_file: {"tool":"write_file","path":"relative/path","content":"full file content"}
- edit_file: {"tool":"edit_file","path":"relative/path","old":"anchor","new":"replacement"}
- run_command: {"tool":"run_command","command":"shell","purpose":"setup|verify|run-project","background":false}
- escalate: {"tool":"escalate","reason":"why you are blocked"}
- finish: {"tool":"finish","summary":"what you accomplished"}

[WORKFLOW]

explore (session snapshot) → think (command plan) → read → edit or write → verify → finish

Example turn:
${THINKING_TAG_OPEN}
know:   [from session snapshot]
need:   [gap]
action: read_file
risk:   [missing file]
verify: [content returned]
${THINKING_TAG_CLOSE}
${TOOL_START}{"tool":"read_file","path":"src/main.ts"}${TOOL_END}
`.trim();

/** Regular expression to match tool blocks between markers. */
const TOOL_BLOCK_REGEX = /<<TOOL>>([\s\S]*?)<<END>>/g;

/**
 * <Summary>
 * What it does:
 *   Parses a JSON string into a validated AgentToolCall object.
 *
 * How it does it (step by step):
 *   1. Parse JSON string into unknown object.
 *   2. Extract tool name from parsed object.
 *   3. Validate and construct specific tool call based on tool name.
 *   4. For each tool type, validate required fields and types.
 *   5. Return null if validation fails or JSON is invalid.
 *
 * Parameters:
 *   @param raw - The JSON string to parse.
 *
 * Returns:
 *   Validated AgentToolCall or null if parsing/validation fails.
 *
 *   - parseAllToolCalls — parses each tool block.
 * </Summary>
 */
export const parseAgentToolCall = (
  rawJsonString: string,
): AgentToolCall | null => {
  try {
    // Step 1: Parse JSON string into unknown object
    const parsedObject = JSON.parse(rawJsonString) as Record<string, unknown>;
    // Step 2: Extract tool name from parsed object
    const toolName = parsedObject.tool;

    // Step 3-4: Validate and construct specific tool call based on tool name
    if (toolName === "read_file" && typeof parsedObject.path === "string") {
      return { tool: "read_file", path: parsedObject.path };
    }

    if (
      toolName === "write_file" &&
      typeof parsedObject.path === "string" &&
      typeof parsedObject.content === "string"
    ) {
      return {
        tool: "write_file",
        path: parsedObject.path,
        content: parsedObject.content,
      };
    }

    if (
      toolName === "edit_file" &&
      typeof parsedObject.path === "string" &&
      typeof parsedObject.old === "string" &&
      typeof parsedObject.new === "string"
    ) {
      // Empty old string is invalid (would match everything)
      if (parsedObject.old.length === 0) {
        return null;
      }
      return {
        tool: "edit_file",
        path: parsedObject.path,
        old: parsedObject.old,
        new: parsedObject.new,
        replace_all: parsedObject.replace_all === true,
      };
    }

    if (
      toolName === "run_command" &&
      typeof parsedObject.command === "string"
    ) {
      const purposeValue = parsedObject.purpose;
      // Validate purpose is one of the allowed values
      const validPurpose: CommandPurpose | undefined =
        purposeValue === "setup" ||
        purposeValue === "verify" ||
        purposeValue === "run-project"
          ? purposeValue
          : undefined;
      return {
        tool: "run_command",
        command: parsedObject.command,
        purpose: validPurpose,
        background: parsedObject.background === true,
      };
    }

    if (toolName === "escalate" && typeof parsedObject.reason === "string") {
      return { tool: "escalate", reason: parsedObject.reason };
    }

    if (toolName === "finish" && typeof parsedObject.summary === "string") {
      return { tool: "finish", summary: parsedObject.summary };
    }
  } catch {
    // Step 5: Return null if JSON is invalid
    return null;
  }
  // Step 5: Return null if validation fails
  return null;
};

/**
 * <Summary>
 * What it does:
 *   Parses all tool call blocks from a text response.
 *
 * How it does it (step by step):
 *   1. Initialize empty array for parsed tool calls.
 *   2. Create regex from TOOL_BLOCK_REGEX pattern.
 *   3. Iterate through all matches in the text.
 *   4. Parse each match and add to array if valid.
 *   5. Log error if parsing fails.
 *   6. Return array of all successfully parsed tool calls.
 *
 * Parameters:
 *   @param text - The LLM response text containing tool blocks.
 *
 * Returns:
 *   Array of all successfully parsed tool calls.
 *
 *   - extractToolFromText — gets first tool call.
 * </Summary>
 */
export const parseAllToolCalls = (text: string): AgentToolCall[] => {
  // Step 1: Initialize empty array for parsed tool calls
  const parsedCalls: AgentToolCall[] = [];
  // Step 2: Reset regex lastIndex for fresh matching
  TOOL_BLOCK_REGEX.lastIndex = 0;
  // Step 3-5: Iterate through all matches in the text
  let regexMatch: RegExpExecArray | null;
  while ((regexMatch = TOOL_BLOCK_REGEX.exec(text)) !== null) {
    const parsedCall = parseAgentToolCall(regexMatch[1].trim());
    if (parsedCall) {
      parsedCalls.push(parsedCall);
    } else {
      // Log error if parsing fails (show first 200 chars for debugging)
      console.error(
        "[Agent] Failed to parse tool call JSON:",
        regexMatch[1].slice(0, 200),
      );
    }
  }
  // Step 6: Return array of all successfully parsed tool calls
  return parsedCalls;
};

/**
 * <Summary>
 * What it does:
 *   Extracts the first tool call from a text response.
 *
 * How it does it (step by step):
 *   1. Parse all tool calls from the text.
 *   2. Return the first one or null if none found.
 *
 * Parameters:
 *   @param text - The LLM response text containing tool blocks.
 *
 * Returns:
 *   First tool call or null if no tool calls found.
 *
 *   - Agent.run — extracts single tool call per turn.
 * </Summary>
 */
export const extractToolFromText = (text: string): AgentToolCall | null => {
  // Step 1-2: Parse all tool calls and return first one
  const allToolCalls = parseAllToolCalls(text);
  return allToolCalls[0] ?? null;
};

/**
 * <Summary>
 * What it does:
 *   Detects when the model output code/markdown instead of tool calls.
 *
 * How it does it (step by step):
 *   1. Trim whitespace from text.
 *   2. Return false for empty text.
 *   3. Check for code fences (``` or ~~~).
 *   4. Check for partial code fences in long text.
 *   5. Count lines that look like code (imports, declarations, etc.).
 *   6. Return true if enough code-like lines exist.
 *
 * Parameters:
 *   @param text - The LLM response text to analyze.
 *
 * Returns:
 *   True if text looks like code/markdown dump, false otherwise.
 *
 *   - Agent.run — decides whether to send correction message.
 * </Summary>
 */
export const looksLikeMarkdownOrCodeDump = (text: string): boolean => {
  // Step 1: Trim whitespace from text
  const trimmedText = text.trim();
  // Step 2: Return false for empty text
  if (trimmedText.length === 0) {
    return false;
  }
  // Step 3: Check for code fences (``` or ~~~)
  if (
    /```[\s\S]*?```/.test(trimmedText) ||
    /~~~[\s\S]*?~~~/.test(trimmedText)
  ) {
    return true;
  }
  // Step 4: Check for partial code fences in long text
  if (trimmedText.includes("```") && trimmedText.length > 200) {
    return true;
  }
  // Step 5: Count lines that look like code
  const lines = trimmedText.split("\n");
  let codeLikeLineCount = 0;
  for (const line of lines) {
    const trimmedLine = line.trim();
    // Check for common code patterns
    if (
      /^(import |export |const |let |var |function |class |interface |type )/.test(
        trimmedLine,
      ) ||
      /[{};]\s*$/.test(trimmedLine)
    ) {
      codeLikeLineCount += 1;
    }
  }
  // Step 6: Return true if enough code-like lines exist
  return codeLikeLineCount >= 8 && lines.length >= 10;
};

/**
 * <Summary>
 * What it does:
 *   Incremental parser that extracts tool calls from streaming LLM responses.
 *
 * How it fits in the system:
 *   As the LLM streams tokens, this parser buffers them and detects
 *   when tool call markers appear. It emits text outside tool blocks
 *   and returns completed tool JSON when a tool block closes.
 *
 *   - Agent.run — parses streaming LLM responses.
 * </Summary>
 */
export class ToolStreamParser {
  /** Buffer for accumulating incoming stream chunks. */
  private streamBuffer = "";

  /** Flag indicating if we're currently inside a tool block. */
  private insideToolBlock = false;

  /**
   * <Summary>
   * What it does:
   *   Feeds a chunk of text to the parser and emits text/tool calls.
   *
   * How it does it (step by step):
   *   1. Append chunk to buffer.
   *   2. If not in tool block, look for TOOL_START marker.
   *   3. Emit text before marker and keep potential partial marker.
   *   4. If marker found, emit text before it and enter tool mode.
   *   5. If in tool block, look for TOOL_END marker.
   *   6. If end found, parse JSON and return tool call.
   *   7. Return null if no complete tool call yet.
   *
   * Parameters:
   *   @param chunk - New text chunk from the stream.
   *   @param emitText - Callback to emit text outside tool blocks.
   *
   * Returns:
   *   Completed tool call or null if not yet complete.
   * </Summary>
   */
  feed = (
    chunk: string,
    emitText: (text: string) => void,
  ): AgentToolCall | null => {
    // Step 1: Append chunk to buffer
    this.streamBuffer += chunk;

    // Step 2-4: If not in tool block, look for TOOL_START marker
    if (!this.insideToolBlock) {
      const startIndex = this.streamBuffer.indexOf(TOOL_START);
      if (startIndex === -1) {
        // No marker yet, emit text but keep potential partial marker
        if (this.streamBuffer.length > TOOL_START.length) {
          const keepBuffer = this.streamBuffer.slice(-TOOL_START.length);
          const textToEmit = this.streamBuffer.slice(0, -TOOL_START.length);
          if (textToEmit.length > 0) {
            emitText(textToEmit);
          }
          this.streamBuffer = keepBuffer;
        }
        return null;
      }
      // Marker found, emit text before it and enter tool mode
      const textBeforeMarker = this.streamBuffer.slice(0, startIndex);
      if (textBeforeMarker.length > 0) {
        emitText(textBeforeMarker);
      }
      this.streamBuffer = this.streamBuffer.slice(
        startIndex + TOOL_START.length,
      );
      this.insideToolBlock = true;
    }

    // Step 5-6: If in tool block, look for TOOL_END marker
    if (this.insideToolBlock) {
      const endIndex = this.streamBuffer.indexOf(TOOL_END);
      if (endIndex === -1) {
        return null; // Still waiting for end marker
      }
      const jsonString = this.streamBuffer.slice(0, endIndex).trim();
      this.streamBuffer = this.streamBuffer.slice(endIndex + TOOL_END.length);
      this.insideToolBlock = false;
      // Step 7: Parse and return tool call
      return parseAgentToolCall(jsonString);
    }

    return null;
  };

  /**
   * <Summary>
   * What it does:
   *   Flushes any remaining text buffer outside tool blocks.
   *
   * How it does it (step by step):
   *   1. Check if we're not in a tool block and have buffered text.
   *   2. Emit the buffered text.
   *   3. Clear the buffer.
   *
   * Parameters:
   *   @param emitText - Callback to emit remaining text.
   * </Summary>
   */
  flushText = (emitText: (text: string) => void): void => {
    // Step 1-3: Emit remaining text if not in tool block
    if (!this.insideToolBlock && this.streamBuffer.length > 0) {
      emitText(this.streamBuffer);
      this.streamBuffer = "";
    }
  };

  /**
   * <Summary>
   * What it does:
   *   Resets the parser state for reuse with a new stream.
   *
   * How it does it (step by step):
   *   1. Clear the stream buffer.
   *   2. Reset the inside tool block flag.
   * </Summary>
   */
  reset = (): void => {
    // Step 1-2: Clear buffer and reset state
    this.streamBuffer = "";
    this.insideToolBlock = false;
  };
}
