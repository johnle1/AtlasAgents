/**
 * Extracts reusable preference rules from task experiences.
 *
 * @remarks
 * Implements {@link IPatternExtractor} to analyze completed task experiences
 * and extract generalizable lessons. Runs asynchronously (fire-and-forget)
 * after {@link ExperienceRecorder.finish}.
 *
 * **Three Rule Sources:**
 * 1. **Agent extraction** — LLM analyzes subsubagent behavior and outputs JSON rules
 * 2. **Fix rules** — Escalations converted to "When X → do Y" patterns (high confidence)
 * 3. **Style rules** — User edits converted to style/formatting preferences (language-scoped)
 *
 * **Workflow:**
 * 1. ExperienceRecorder.finish triggers `extract(record)` (fire-and-forget)
 * 2. extract() calls private `run()` asynchronously
 * 3. run() skips failures with no escalations (no learning data)
 * 4. Builds comprehensive prompt with task, diffs, escalations, edits
 * 5. Queries subagent model for JSON array of rules
 * 6. Validates and persists each rule to preference store
 * 7. Independently converts escalations and edits to fix/style rules
 * 8. Returns without awaiting (background learning)
 *
 * **Error Handling:**
 * - Logs but doesn't crash on subagent failures
 * - Invalid JSON gracefully degrades to escalation/edit rules only
 * - Preference store errors logged but don't block task completion
 *
 * @see {@link PreferenceStore} for rule persistence
 */

import type {
  IConfigManager,
  IOllamaClient,
  IPatternExtractor,
  IPreferenceStore,
  NewPreferenceRule,
} from "../../orchestration/interfaces.js";
import type { Message } from "../../orchestration/types.js";
import type { ExperienceRecord } from "../types.js";
import {
  AGENT_WRITE_DIFF_BUDGET,
  ESCALATION_GUIDANCE_BUDGET,
  ESCALATION_REASON_BUDGET,
  STYLE_RULE_DIFF_BUDGET,
} from "./patternConstants.js";
import {
  errorKeywords,
  extractJsonArray,
  formatUserEditForPrompt,
  parseConfidence,
  plainDiffFromEdit,
  sampleUserEdits,
  scopeFromPath,
  topicsFromPath,
  truncate,
} from "./patternHelpers.js";
import { logger } from "../../logger.js";

/**
 * Extracts reusable preference rules from task experiences.
 *
 * @remarks
 * Analyzes completed task experiences and extracts generalizable lessons using
 * three sources: agent LLM analysis, escalation-based fix rules, and user-edit
 * style rules. Runs asynchronously as a fire-and-forget background process.
 *
 * @example
 * ```ts
 * const extractor = new PatternExtractor({
 *   ollama: ollamaClient,
 *   config: configManager,
 *   prefs: preferenceStore
 * });
 * extractor.extract(experienceRecord); // runs in background
 * ```
 */
export class PatternExtractor implements IPatternExtractor {
  /**
   * Initializes the pattern extractor with required dependencies.
   *
   * @param deps - Dependency bag containing the following services:
   *   @param deps.ollama - Client for communicating with the agent AI model.
   *   @param deps.config - Manager for reading configuration (model name, temperature).
   *   @param deps.prefs - Store for persisting extracted preference rules.
   */
  constructor(
    private readonly deps: {
      ollama: IOllamaClient;
      config: IConfigManager;
      prefs: IPreferenceStore;
    },
  ) {}

  /**
   * Enqueues a non-blocking extraction run for a completed experience record.
   *
   * @remarks
   * Starts the async extraction work in the background without awaiting the result.
   * Errors are logged but do not propagate to the caller. This is the public
   * entry point called by {@link ExperienceRecorder.finish}.
   *
   * @param record - The finished experience to analyze.
   */
  extract = (record: ExperienceRecord): void => {
    // Step 1: Start the async work and attach error logging (fire-and-forget)
    // We intentionally don't await this promise because we want this to run
    // in the background without blocking the caller. The error handler ensures
    // that any failures are logged even though we're not awaiting the result.
    // The `void` prefix tells TypeScript and linters we're intentionally ignoring the promise.
    void this.run(record).catch((error) => {
      logger.error(
        { taskId: record.taskId, err: error },
        "PatternExtractor run failed",
      );
    });
  };

  /**
   * Core extraction implementation.
   *
   * @remarks
   * Performs the actual extraction work asynchronously:
   * 1. Early-exit for failed outcomes without escalations (nothing to learn)
   * 2. Builds human-readable context blocks: paths, subagent write diffs, escalations, user edits
   * 3. Constructs a prompt instructing the agent to return JSON array of preference objects
   * 4. Queries the subagent model using configured model + temperature
   * 5. Parses JSON array from the subagent response using {@link extractJsonArray}
   * 6. Validates each rule and persists to the preference store
   * 7. Independently converts escalations to fix rules and user edits to style rules
   *
   * Agent chat failures are caught and logged but do not prevent escalation/edit
   * rule extraction. Invalid JSON gracefully degrades to fix/style rules only.
   *
   * @param record - The experience being processed.
   */
  private run = async (record: ExperienceRecord): Promise<void> => {
    // Step 1: If the task failed but produced no escalations, nothing to do
    // This is an early exit optimization. If a task failed without any escalations,
    // there's no meaningful information to extract from the experience.
    // Escalations represent specific failure patterns that we can learn from,
    // so without them, a generic failure doesn't provide useful learning data.
    if (record.outcome === "failure" && record.escalations.length === 0) {
      return;
    }

    // Step 2: Summarize files read/written, subagent write diffs, escalations, user edits
    // This step builds a comprehensive but budgeted summary of the experience
    // that will be sent to the subagent model. Each section is carefully truncated
    // to avoid overwhelming the model while preserving the most relevant information.
    // The goal is to provide enough context for the agent to extract meaningful rules
    // without exceeding context window limits or including irrelevant details.

    // Extract just the file paths (not full file objects) for read operations
    // This gives us context about what files the agent needed to understand
    // We use map to transform each fileEntry object into just its path string
    const readPaths = record.filesRead.map((fileEntry) => fileEntry.path);

    // Extract just the file paths for write operations
    // This shows what files the subagent modified during the task
    // This helps the agent understand which parts of the codebase were changed
    const writePaths = record.filesWritten.map((fileEntry) => fileEntry.path);

    // Build a formatted block showing the actual diffs the agent wrote
    // We filter out empty diffs (where the agent didn't actually change anything)
    // and format each one with the file path for clarity
    // Each diff is truncated to AGENT_WRITE_DIFF_BUDGET to stay within token limits
    // The formatting adds indentation to make the diffs more readable in the prompt
    const agentWriteBlock = record.filesWritten
      .filter((writeEntry) => writeEntry.diff.trim().length > 0)
      .map(
        (writeEntry) =>
          `- ${writeEntry.path}\n  Diff:\n${truncate(
            writeEntry.diff,
            AGENT_WRITE_DIFF_BUDGET,
          )
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n")}`,
      )
      .join("\n");

    // Build a formatted block showing all escalations that occurred
    // Each escalation includes a reason (what went wrong) and guidance (how to fix it)
    // Both fields are truncated to their respective budget limits to manage token usage
    // These are particularly valuable for learning because they represent human intervention points
    const escalationBlock = record.escalations
      .map(
        (escalationEntry) =>
          `- Reason: ${truncate(escalationEntry.reason, ESCALATION_REASON_BUDGET)}\n  Guidance: ${truncate(escalationEntry.guidance, ESCALATION_GUIDANCE_BUDGET)}`,
      )
      .join("\n");

    // Sample user edits to avoid overwhelming the subagent model
    // The sampleUserEdits function intelligently selects a representative subset
    // of edits and tells us how many were omitted for transparency
    // This is important because there could be hundreds of user edits in a single session
    const { edits: sampledEdits, omitted: omittedEdits } = sampleUserEdits(
      record.userEdits,
    );

    // Format the sampled user edits for the prompt
    // Each edit is converted into a readable format showing what changed
    // The formatUserEditForPrompt function creates a consistent, parseable format
    const editBlock = sampledEdits.map(formatUserEditForPrompt).join("\n");

    // Add a note if we omitted any edits so the agent knows the data is partial
    // This maintains transparency about the sampling process
    // It prevents the agent from assuming it has seen all user corrections
    const editOmittedNote =
      omittedEdits > 0 ? `\n(... ${omittedEdits} more user edits omitted)` : "";

    // Step 3: Build user-visible prompt telling the agent what to extract
    // This prompt provides the subagent model with a comprehensive summary of the
    // task experience and instructs it to extract general, reusable rules.
    // The prompt is structured to be human-readable for debugging and model-comprehensible.
    const agentPrompt = [
      // Basic task information - what was attempted and how it turned out
      `Task: ${record.task}`,
      `Outcome: ${record.outcome ?? "unknown"}`,

      // File context - what files were involved in the task
      // This helps the agent understand the scope and domain of the work
      `Files read: ${readPaths.length > 0 ? readPaths.join(", ") : "(none)"}`,
      `Files written (paths): ${writePaths.length > 0 ? writePaths.join(", ") : "(none)"}`,

      // Agent's actual changes - the diffs show what the agent did
      // This is crucial for understanding the agent's behavior and patterns
      `Agent writes (diffs):\n${agentWriteBlock.length > 0 ? agentWriteBlock : "(none)"}`,

      // Escalations - when the subagent got stuck and needed help
      // These represent specific failure patterns that should be learned from
      `Escalations:\n${escalationBlock.length > 0 ? escalationBlock : "(none)"}`,

      // User corrections - what the user changed after the agent's work
      // These represent user preferences and style corrections
      `User edits after subagent output:\n${editBlock.length > 0 ? editBlock + editOmittedNote : "(none)"}`,

      // Blank line for visual separation
      "",

      // The core question - asking the agent to generalize from this specific experience
      "What general rules should be remembered from this experience to help with similar future tasks?",

      // Strict output format instructions - we need valid JSON, not conversational text
      // This ensures we can parse the response programmatically
      'Return ONLY a JSON array of objects with fields: text (string), topics (string[]), scope (string), confidence ("high"|"medium"|"low"). No markdown, no prose.',
    ].join("\n");

    // Step 4: Read model configuration and prepare chat messages
    // We need to configure the subagent model with the right parameters
    // The model name determines which AI model to use (e.g., llama2, mistral)
    // The temperature controls randomness (0.0 = deterministic, 1.0 = creative)
    const model = await this.deps.config.getSubagentModel();
    const temperature = await this.deps.config.getAgentTemperature();

    // Construct the chat messages in the format expected by the Ollama client
    // The system message sets the persona and behavioral constraints
    // The user message contains the actual task and data to process
    const messages: Message[] = [
      {
        role: "system",
        content:
          "You extract durable coding preferences and lessons from task experiences. Output only valid JSON arrays.",
      },
      { role: "user", content: agentPrompt },
    ];

    try {
      // Step 5: Query the agent and attempt to parse its JSON array output
      // This is the core operation where we send the prompt to the AI model
      // and get back its analysis. We use the configured model and temperature.
      // The chat call may fail due to network issues or model errors, so it's wrapped in try-catch.
      // We await this call because we need the response before we can proceed with parsing.
      const rawAgentResponse = await this.deps.ollama.chat(model, messages, {
        temperature,
      });

      // Attempt to parse the JSON array from the agent's response
      // The extractJsonArray helper extracts the JSON array from the raw response text
      // even if it's embedded in markdown code blocks or conversational text
      // This is necessary because LLMs often wrap JSON in markdown or add conversational filler
      let parsedRules: unknown;
      try {
        // First extract the JSON array string from the raw response
        // Then parse it as JSON to get a JavaScript object/array
        parsedRules = JSON.parse(extractJsonArray(rawAgentResponse)) as unknown;
      } catch {
        // If parsing fails, log and continue to handle escalations/edits
        // This is a graceful failure - we still want to process escalations and user edits
        // even if the agent's JSON output was malformed or missing
        // We set parsedRules to null to indicate the parsing failed
        logger.warn(
          { taskId: record.taskId },
          "PatternExtractor received invalid JSON from agent",
        );
        parsedRules = null;
      }

      // Step 6: If the agent returned a JSON array, validate and store
      // We validate each rule to ensure it meets our minimum requirements
      // This prevents malformed or empty rules from being stored
      // Validation is crucial because the subagent output is untrusted and could be malformed
      if (Array.isArray(parsedRules)) {
        for (const ruleItem of parsedRules) {
          // Validate shape — require a non-empty `text` string
          // The text field is the most important part of a rule - it must exist
          // We reject non-objects and null values to prevent runtime errors
          if (typeof ruleItem !== "object" || ruleItem === null) {
            continue; // Skip non-objects or null values
          }
          const ruleObject = ruleItem as Record<string, unknown>;
          const ruleText =
            typeof ruleObject.text === "string" ? ruleObject.text.trim() : "";
          if (ruleText.length === 0) {
            continue; // Skip rules with empty text
          }

          // Normalize optional fields: topics (string[]), scope (string)
          // We provide sensible defaults for missing or malformed optional fields
          // Topics help categorize the rule by subject area (e.g., "testing", "react")
          const ruleTopics = Array.isArray(ruleObject.topics)
            ? ruleObject.topics.filter(
                (topicItem): topicItem is string =>
                  typeof topicItem === "string",
              )
            : []; // Default to empty array if topics is missing or invalid

          // Scope defines where the rule applies (e.g., "typescript", "python", "all")
          // "all" is the default because rules without a specified scope should apply globally
          const ruleScope =
            typeof ruleObject.scope === "string" && ruleObject.scope.length > 0
              ? ruleObject.scope
              : "all"; // Default to "all" if scope is missing or empty

          // Build a NewPreferenceRule and persist it
          // The parseConfidence helper normalizes confidence values to our enum
          // This ensures we only store valid confidence values (high, medium, low)
          const rule: NewPreferenceRule = {
            text: ruleText,
            topics: ruleTopics,
            scope: ruleScope,
            confidence: parseConfidence(ruleObject.confidence),
            source: "outcome", // Marks this as a general rule learned from the task outcome
          };
          // Store the rule in the preference store for future use
          // This is an async operation, but we await it to ensure storage completes
          await this.deps.prefs.add(rule);
        }
      }
    } catch (error) {
      // Step 5b: Fail the chat call gracefully and continue to other work
      // If the subagent chat fails (network error, model unavailable, etc.),
      // we log the error but continue to process escalations and user edits.
      // This ensures we still capture some learning data even if the AI analysis fails.
      // We don't re-throw because this is a background process and failures shouldn't crash the system
      logger.error(
        { taskId: record.taskId, err: error },
        "PatternExtractor subagent chat failed",
      );
    }

    // Step 7a: Convert recorded escalations into high-confidence fix rules
    // Escalations represent specific failure patterns where the subagent needed help.
    // We convert these into "fix" rules with high confidence because they represent
    // explicit guidance that was needed to resolve the issue.
    // These are particularly valuable because they represent human intervention points
    // where the agent's normal approach failed and required correction.
    for (const escalation of record.escalations) {
      const fixRule: NewPreferenceRule = {
        // Create a rule that maps the failure reason to the fix guidance
        // This creates an "if X happens, do Y" pattern that can be reused
        // The arrow notation (→) makes it clear this is a cause-effect relationship
        text: `When ${escalation.reason} → ${escalation.guidance}`,
        // Extract keywords from the error reason for topic categorization
        // This helps match the rule to similar error situations in the future
        topics: errorKeywords(escalation.reason),
        // Fix rules apply globally by default since they're about general problem-solving
        // The scope is "all" because failure patterns often transcend specific languages
        scope: "all",
        // High confidence because this is explicit human-provided guidance
        // Unlike general subagent suggestions, escalation guidance comes from human intervention
        confidence: "high",
        // Mark as a "fix" rule to indicate it's about resolving specific problems
        // This distinguishes it from style rules (source: "style") and general rules (source: "outcome")
        source: "fix",
      };
      // Store the fix rule in the preference store
      // We await this to ensure the rule is persisted before continuing
      await this.deps.prefs.add(fixRule);
    }

    // Step 7b: Convert user edits into style-preference rules with a short diff hint
    // User edits represent the user's corrections to the agent's work.
    // These often reveal style preferences, formatting choices, or specific patterns
    // the user prefers. We convert these into "style" rules with high confidence.
    // These rules are language-specific because style preferences vary by language.
    for (const userEdit of record.userEdits) {
      // Determine the language/scope from the file path (e.g., "typescript", "python")
      // This ensures style rules only apply to the appropriate language context
      // Python style preferences shouldn't apply to TypeScript code, for example
      const languageScope = scopeFromPath(userEdit.path);

      // Create a simplified diff snippet to show what changed
      // The plainDiffFromEdit function generates a readable diff within the budget
      // STYLE_RULE_DIFF_BUDGET keeps the diff concise while showing the key changes
      const diffSnippet = plainDiffFromEdit(
        userEdit.before,
        userEdit.after,
        userEdit.path,
        STYLE_RULE_DIFF_BUDGET,
      );

      const styleRule: NewPreferenceRule = {
        // Create a rule that shows what the user preferred for this specific file
        // We replace newlines with spaces to keep the text as a single line
        // This makes the rule more readable and easier to store/display
        text: `For ${userEdit.path}, user preferred: ${diffSnippet.replace(/\n/g, " ")}`,
        // Extract topics from the file path (e.g., "react", "testing", "api")
        // This helps categorize the rule by the domain or technology involved
        topics: topicsFromPath(userEdit.path),
        // Scope this rule to the specific language of the file
        // Style rules are language-specific because conventions vary by language
        scope: languageScope,
        // High confidence because this is an actual user correction
        // User actions are the strongest signal of preference
        confidence: "high",
        // Mark as a "style" rule to indicate it's about code style/preferences
        // This distinguishes it from fix rules (source: "fix") and general rules (source: "outcome")
        source: "style",
      };
      // Store the style rule in the preference store
      // We await this to ensure the rule is persisted before continuing
      await this.deps.prefs.add(styleRule);
    }
  };
}
