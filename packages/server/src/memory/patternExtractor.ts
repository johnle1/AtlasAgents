/**
 * <Summary>
 * What it does:
 *   Reads finished experience records and extracts reusable preference rules via
 *   the advisor model; always runs asynchronously after task finish.
 *
 * How it fits in the system:
 *   Triggered fire-and-forget by ExperienceRecorder.finish.
 *
 * Dependencies:
 *   - IOllamaClient, IConfigManager — advisor chat.
 *   - IPreferenceStore — persists learned rules.
 *
 * Dependants:
 *   - ExperienceRecorder.
 * </Summary>
 */

import * as path from "node:path";

import type {
  IConfigManager,
  IOllamaClient,
  IPatternExtractor,
  IPreferenceStore,
  NewPreferenceRule,
  PreferenceConfidence,
} from "../orchestration/interfaces.js";
import type { Message } from "../orchestration/types.js";
import { computeDiff, formatDiffPlain } from "../workspace/diffEngine.js";
import type { ExperienceRecord, UserEditEntry } from "./types.js";

const ESCALATION_REASON_BUDGET = 200;
const ESCALATION_GUIDANCE_BUDGET = 600;
const USER_EDIT_DIFF_BUDGET = 600;
const AGENT_WRITE_DIFF_BUDGET = 400;
const STYLE_RULE_DIFF_BUDGET = 200;
const MAX_USER_EDITS_IN_PROMPT = 5;

/**
 * <Summary>
 * What it does:
 *   Extracts a JSON array string from a raw advisor/LLM response. The
 *   assistant may return the array either raw or wrapped inside a Markdown
 *   code fence (optionally labeled "json"). This helper returns the
 *   substring that looks like a JSON array (including brackets) so callers
 *   can safely `JSON.parse()` it.
 *
 * How it does it (step by step):
 *   1. Trim surrounding whitespace from the raw response.
 *   2. Attempt to capture the first fenced code block using a regex that
 *      accepts an optional "json" language label.
 *   3. If a fenced block is found, use its inner contents as the body;
 *      otherwise use the trimmed raw text.
 *   4. Find the first `[` and the last `]` in the body.
 *   5. If both brackets exist and the end index is after the start index,
 *      return the substring from `[` to `]` inclusive (the JSON array).
 *   6. If a plausible array can't be located, return the full body so the
 *      caller can still attempt to parse or log the raw response.
 *
 * Parameters:
 *   @param {string} raw — Raw text returned by the advisor/LLM.
 *
 * Returns:
 *   {string} — The extracted JSON array text (or the original body if no
 *   well-formed array boundaries were found).
 *
 * Dependants:
 *   - The caller expects a string that can be passed to `JSON.parse()`.
 * </Summary>
 */
const extractJsonArray = (raw: string): string => {
  // Step 1: Trim surrounding whitespace/newlines
  const trimmedResponse = raw.trim();

  // Step 2: Try to capture a fenced code block. Supports both ```json and ```
  // The capture group grabs everything between the fences (including newlines).
  const codeFenceMatch = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```/i.exec(
    trimmedResponse,
  );

  // Step 3: Prefer the fenced block content when present, otherwise use raw
  const extractedBody = codeFenceMatch
    ? codeFenceMatch[1].trim()
    : trimmedResponse;

  // Step 4: Locate the first opening bracket and the last closing bracket.
  // This is a pragmatic way to extract the outermost JSON array in the body.
  const arrayStartIndex = extractedBody.indexOf("[");
  const arrayEndIndex = extractedBody.lastIndexOf("]");

  // Step 5: If a matching pair of brackets exists and the end comes after
  // the start, slice out that range (include the closing bracket). This
  // returns a string like "[ {...}, {...} ]" which callers can parse.
  if (
    arrayStartIndex !== -1 &&
    arrayEndIndex !== -1 &&
    arrayEndIndex > arrayStartIndex
  ) {
    return extractedBody.slice(arrayStartIndex, arrayEndIndex + 1);
  }

  // Step 6: Fallback — return the full body so caller can decide how to
  // handle malformed or unexpected responses (logging, retries, etc.).
  return extractedBody;
};

/**
 * <Summary>
 * What it does:
 *   Truncates a string to a maximum length and appends an ellipsis when
 *   the text is longer than the allowed maximum.
 *
 * How it does it (step by step):
 *   1. Check if `text.length` is less than or equal to `max`.
 *   2. If yes, return the original `text` untouched.
 *   3. Otherwise, take the first `max` characters and append `…`.
 *
 * Parameters:
 *   @param {string} text — Input string to trim.
 *   @param {number} max — Maximum allowed length before truncation.
 *
 * Returns:
 *   {string} — Either the original text (if short) or a truncated version
 *   with a trailing ellipsis.
 *
 * Dependants:
 *   - Logging and user-visible message formatting elsewhere in the module.
 * </Summary>
 */
const truncate = (text: string, max: number): string => {
  // Step 1: If the text already fits, return it directly.
  if (text.length <= max) {
    return text;
  }

  // Step 2: Otherwise return the prefix + ellipsis to indicate truncation.
  return `${text.slice(0, max)}…`;
};

/**
 * <Summary>
 * What it does:
 *   Builds a plain-text line diff from before/after file contents for prompts.
 *
 * How it does it (step by step):
 *   1. Run computeDiff on before and after strings.
 *   2. Format with formatDiffPlain (no ANSI colors).
 *   3. Truncate to max length when provided.
 *
 * Parameters:
 *   @param {string} before — Content before edit.
 *   @param {string} after — Content after edit.
 *   @param {string} filePath — Path for optional header in diff output.
 *   @param {number} [maxLen] — Optional character budget; omit for full diff.
 *
 * Returns:
 *   @returns {string} — Plain diff text.
 *
 * Dependants:
 *   - formatUserEditForPrompt, style rule generation in run.
 * </Summary>
 */
const plainDiffFromEdit = (
  before: string,
  after: string,
  filePath: string,
  maxLen?: number,
): string => {
  const chunks = computeDiff(before, after);
  const plain = formatDiffPlain(chunks, filePath);
  if (maxLen === undefined) {
    return plain;
  }
  return truncate(plain, maxLen);
};

/**
 * <Summary>
 * What it does:
 *   Formats one user edit as a prompt line with a plain diff (not before/after slices).
 *
 * Parameters:
 *   @param {UserEditEntry} edit — User edit row from the experience record.
 *
 * Returns:
 *   @returns {string} — Multi-line block for the advisor prompt.
 *
 * Dependants:
 *   - PatternExtractor.run editBlock.
 * </Summary>
 */
const formatUserEditForPrompt = (edit: UserEditEntry): string => {
  const diffText = plainDiffFromEdit(
    edit.before,
    edit.after,
    edit.path,
    USER_EDIT_DIFF_BUDGET,
  );
  return `- ${edit.path}\n  Diff:\n${diffText.split("\n").map((line) => `    ${line}`).join("\n")}`;
};

/**
 * <Summary>
 * What it does:
 *   Limits user edits included in the advisor prompt to avoid huge prompts.
 *
 * Parameters:
 *   @param {UserEditEntry[]} edits — All user edits on the record.
 *
 * Returns:
 *   @returns {{ edits: UserEditEntry[]; omitted: number }} — Sample and omit count.
 *
 * Dependants:
 *   - PatternExtractor.run.
 * </Summary>
 */
const sampleUserEdits = (
  edits: UserEditEntry[],
): { edits: UserEditEntry[]; omitted: number } => {
  if (edits.length <= MAX_USER_EDITS_IN_PROMPT) {
    return { edits, omitted: 0 };
  }
  return {
    edits: edits.slice(0, MAX_USER_EDITS_IN_PROMPT),
    omitted: edits.length - MAX_USER_EDITS_IN_PROMPT,
  };
};

/**
 * <Summary>
 * What it does:
 *   Determines a language scope string from a file path's extension. This
 *   maps common file extensions to higher-level language identifiers used
 *   for scoping preference rules.
 *
 * How it does it (step by step):
 *   1. Extract the file extension using `path.extname` and normalize to
 *      lower-case.
 *   2. Look up the extension in a predefined `map` from extensions to
 *      language scope strings.
 *   3. If the extension is unknown, return the fallback scope `all`.
 *
 * Parameters:
 *   @param {string} filePath — The path to the file whose language should
 *   be determined.
 *
 * Returns:
 *   {string} — A scope identifier such as `typescript`, `python`, or `all`.
 *
 * Dependants:
 *   - `topicsFromPath` and generation of `style` preference rules.
 * </Summary>
 */
const scopeFromPath = (filePath: string): string => {
  // Step 1: Extract the extension and normalize to lower-case
  const fileExtension = path.extname(filePath).toLowerCase();

  // Step 2: Map common extensions to language scopes
  const extensionToScopeMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".c": "c",
    ".swift": "swift",
    ".kt": "kotlin",
  };

  // Step 3: Return mapped scope or fallback to 'all'
  return extensionToScopeMap[fileExtension] ?? "all";
};

/**
 * <Summary>
 * What it does:
 *   Produces a list of topic strings derived from a file path. For now this
 *   is a thin wrapper that returns the language scope (unless it's `all`).
 *
 * How it does it (step by step):
 *   1. Call `scopeFromPath` to determine the language scope for `filePath`.
 *   2. If the scope is `all`, return an empty array (no specific topics).
 *   3. Otherwise return an array containing the single scope string.
 *
 * Parameters:
 *   @param {string} filePath — File path used to derive topics.
 *
 * Returns:
 *   {string[]} — Array of topic strings (commonly a single language scope).
 *
 * Dependants:
 *   - Creation of `style` preference rules that tag rules with topics.
 * </Summary>
 */
const topicsFromPath = (filePath: string): string[] => {
  // Step 1: Get the language scope
  const languageScope = scopeFromPath(filePath);

  // Step 2: Return either an empty list for 'all' or the single-topic array
  return languageScope === "all" ? [] : [languageScope];
};

/**
 * <Summary>
 * What it does:
 *   Extracts up to eight short, lower-cased keyword tokens from an error
 *   reason string. These keywords are used as `topics` for fix rules so
 *   that errors can be matched by common words.
 *
 * How it does it (step by step):
 *   1. Normalize the input to lower-case.
 *   2. Split on any character that is not a letter, digit, `+`, or `#`.
 *   3. Filter out tokens shorter than 3 characters to avoid noise.
 *   4. Deduplicate while preserving first-seen order using `Set` and then
 *      limit the result to the first 8 tokens.
 *
 * Parameters:
 *   @param {string} reason — Human-readable error reason or message.
 *
 * Returns:
 *   {string[]} — Up to eight deduplicated keyword tokens.
 *
 * Dependants:
 *   - Fix rule topic generation for escalation-derived preference rules.
 * </Summary>
 */
const errorKeywords = (reason: string): string[] => {
  // Step 1 & 2: Normalize and split on non-alphanumeric/+/# characters
  const keywordTokens = reason
    .toLowerCase()
    .split(/[^a-z0-9+#]+/g)
    .filter((keyword) => keyword.length >= 3); // Step 3: Remove very short tokens

  // Step 4: Deduplicate and limit to 8 entries
  return [...new Set(keywordTokens)].slice(0, 8);
};

/**
 * <Summary>
 * What it does:
 *   Normalizes an untrusted `confidence` value from the advisor output into
 *   the `PreferenceConfidence` union type expected by the preference store.
 *
 * How it does it (step by step):
 *   1. Check whether `raw` strictly equals one of the accepted strings
 *      `'high'`, `'medium'`, or `'low'`.
 *   2. If so, return it unchanged (typed to `PreferenceConfidence`).
 *   3. Otherwise, fall back to the safe default `'medium'`.
 *
 * Parameters:
 *   @param {unknown} raw — The untrusted value produced by the advisor.
 *
 * Returns:
 *   {PreferenceConfidence} — One of `'high'|'medium'|'low'`.
 *
 * Dependants:
 *   - Creating `NewPreferenceRule` objects stored in the preference store.
 * </Summary>
 */
const parseConfidence = (raw: unknown): PreferenceConfidence => {
  // Step 1: Accept only the three explicit string values
  if (raw === "high" || raw === "medium" || raw === "low") {
    return raw;
  }

  // Step 2: Default to 'medium' for anything else (missing or malformed)
  return "medium";
};

/**
 * <Summary>
 * What it does:
 *   Implements extraction of reusable preference rules from a completed
 *   `ExperienceRecord`. Orchestrates asking the advisor model for general
 *   rules, parses and validates its JSON output, and persists resulting
 *   rules into the preference store. Additionally converts escalations and
 *   user edits into high-confidence fix/style rules.
 *
 * How it fits in the system:
 *   - Triggered by `ExperienceRecorder.finish` as a fire-and-forget task.
 *   - Depends on `IOllamaClient` for advisor chat, `IConfigManager` for
 *     model/temperature settings, and `IPreferenceStore` to save rules.
 *
 * Dependants:
 *   - ExperienceRecorder (fires extraction after tasks finish).
 * </Summary>
 */
export class PatternExtractor implements IPatternExtractor {
  /**
   * Constructor
   *
   * Parameters:
   *   @param deps — dependency bag with `ollama`, `config`, and `prefs`.
   */
  constructor(
    private readonly deps: {
      ollama: IOllamaClient;
      config: IConfigManager;
      prefs: IPreferenceStore;
    },
  ) {}

  /**
   * Public entrypoint: enqueue a non-blocking extraction run for a record.
   *
   * How it does it (step by step):
   *   1. Call the private async `run` method and intentionally ignore the
   *      returned promise (fire-and-forget).
   *   2. Attach a catch handler to log any unexpected error.
   *
   * Parameters:
   *   @param {ExperienceRecord} record — The finished experience to analyze.
   *
   * Returns:
   *   void
   */
  extract = (record: ExperienceRecord): void => {
    // Step 1: Start the async work and attach error logging (fire-and-forget)
    void this.run(record).catch((err) => {
      console.error("[PatternExtractor]", err);
    });
  };

  /**
   * Core extraction implementation (async).
   *
   * How it does it (step by step):
   *   1. Early-exit for failed outcomes without escalations (nothing to learn).
   *   2. Build human-readable context blocks: paths, agent write diffs,
   *      escalations (budgeted), and user edits as plain line diffs (sampled).
   *   3. Construct a prompt (userContent) instructing the advisor to return
   *      ONLY a JSON array of preference objects.
   *   4. Query the advisor model using configured model + temperature.
   *   5. Use `extractJsonArray` to pull a JSON array string from the raw
   *      model response and attempt to `JSON.parse()` it.
   *   6. If parsed output is an array, validate and convert each item into
   *      a `NewPreferenceRule` and persist it into the preference store.
   *   7. Independently, convert any recorded escalations into `fix` rules
   *      and user edits into `style` rules, saving each to the preference
   *      store.
   *
   * Parameters:
   *   @param {ExperienceRecord} record — The experience being processed.
   *
   * Returns:
   *   Promise<void>
   */
  private run = async (record: ExperienceRecord): Promise<void> => {
    // Step 1: If the task failed but produced no escalations, nothing to do
    if (record.outcome === "failure" && record.escalations.length === 0) {
      return;
    }

    // Step 2: Summarize files read/written, agent write diffs, escalations, user edits
    const readPaths = record.filesRead.map((fileEntry) => fileEntry.path);
    const writePaths = record.filesWritten.map((fileEntry) => fileEntry.path);
    const agentWriteBlock = record.filesWritten
      .filter((writeEntry) => writeEntry.diff.trim().length > 0)
      .map(
        (writeEntry) =>
          `- ${writeEntry.path}\n  Diff:\n${truncate(writeEntry.diff, AGENT_WRITE_DIFF_BUDGET)
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n")}`,
      )
      .join("\n");
    const escalationBlock = record.escalations
      .map(
        (escalationEntry) =>
          `- Reason: ${truncate(escalationEntry.reason, ESCALATION_REASON_BUDGET)}\n  Guidance: ${truncate(escalationEntry.guidance, ESCALATION_GUIDANCE_BUDGET)}`,
      )
      .join("\n");
    const { edits: sampledEdits, omitted: omittedEdits } = sampleUserEdits(
      record.userEdits,
    );
    const editBlock = sampledEdits.map(formatUserEditForPrompt).join("\n");
    const editOmittedNote =
      omittedEdits > 0
        ? `\n(... ${omittedEdits} more user edits omitted)`
        : "";

    // Step 3: Build user-visible prompt telling the advisor what to extract
    const advisorPrompt = [
      `Task: ${record.task}`,
      `Outcome: ${record.outcome ?? "unknown"}`,
      `Files read: ${readPaths.length > 0 ? readPaths.join(", ") : "(none)"}`,
      `Files written (paths): ${writePaths.length > 0 ? writePaths.join(", ") : "(none)"}`,
      `Agent writes (diffs):\n${agentWriteBlock.length > 0 ? agentWriteBlock : "(none)"}`,
      `Escalations:\n${escalationBlock.length > 0 ? escalationBlock : "(none)"}`,
      `User edits after agent output:\n${editBlock.length > 0 ? editBlock + editOmittedNote : "(none)"}`,
      "",
      "What general rules should be remembered from this experience to help with similar future tasks?",
      'Return ONLY a JSON array of objects with fields: text (string), topics (string[]), scope (string), confidence ("high"|"medium"|"low"). No markdown, no prose.',
    ].join("\n");

    // Step 4: Read model configuration and prepare chat messages
    const model = await this.deps.config.getAdvisorModel();
    const temperature = await this.deps.config.getAdvisorTemperature();
    const messages: Message[] = [
      {
        role: "system",
        content:
          "You extract durable coding preferences and lessons from task experiences. Output only valid JSON arrays.",
      },
      { role: "user", content: advisorPrompt },
    ];

    try {
      // Step 5: Query the advisor and attempt to parse its JSON array output
      const rawAdvisorResponse = await this.deps.ollama.chat(model, messages, {
        temperature,
      });
      let parsedRules: unknown;
      try {
        parsedRules = JSON.parse(
          extractJsonArray(rawAdvisorResponse),
        ) as unknown;
      } catch {
        // If parsing fails, log and continue to handle escalations/edits
        console.error("[PatternExtractor] invalid JSON from advisor");
        parsedRules = null;
      }

      // Step 6: If the advisor returned a JSON array, validate and store
      if (Array.isArray(parsedRules)) {
        for (const ruleItem of parsedRules) {
          // Validate shape — require a non-empty `text` string
          if (typeof ruleItem !== "object" || ruleItem === null) {
            continue;
          }
          const ruleObject = ruleItem as Record<string, unknown>;
          const ruleText =
            typeof ruleObject.text === "string" ? ruleObject.text.trim() : "";
          if (ruleText.length === 0) {
            continue;
          }

          // Normalize optional fields: topics (string[]), scope (string)
          const ruleTopics = Array.isArray(ruleObject.topics)
            ? ruleObject.topics.filter(
                (topic): topic is string => typeof topic === "string",
              )
            : [];
          const ruleScope =
            typeof ruleObject.scope === "string" && ruleObject.scope.length > 0
              ? ruleObject.scope
              : "all";

          // Build a NewPreferenceRule and persist it
          const rule: NewPreferenceRule = {
            text: ruleText,
            topics: ruleTopics,
            scope: ruleScope,
            confidence: parseConfidence(ruleObject.confidence),
            source: "outcome",
          };
          await this.deps.prefs.add(rule);
        }
      }
    } catch (err) {
      // Step 5b: Fail the chat call gracefully and continue to other work
      console.error("[PatternExtractor] advisor chat failed:", err);
    }

    // Step 7a: Convert recorded escalations into high-confidence fix rules
    for (const escalation of record.escalations) {
      const fixRule: NewPreferenceRule = {
        text: `When ${escalation.reason} → ${escalation.guidance}`,
        topics: errorKeywords(escalation.reason),
        scope: "all",
        confidence: "high",
        source: "fix",
      };
      await this.deps.prefs.add(fixRule);
    }

    // Step 7b: Convert user edits into style-preference rules with a short diff hint
    for (const userEdit of record.userEdits) {
      const languageScope = scopeFromPath(userEdit.path);
      const diffSnippet = plainDiffFromEdit(
        userEdit.before,
        userEdit.after,
        userEdit.path,
        STYLE_RULE_DIFF_BUDGET,
      );
      const styleRule: NewPreferenceRule = {
        text: `For ${userEdit.path}, user preferred: ${diffSnippet.replace(/\n/g, " ")}`,
        topics: topicsFromPath(userEdit.path),
        scope: languageScope,
        confidence: "high",
        source: "style",
      };
      await this.deps.prefs.add(styleRule);
    }
  };
}
