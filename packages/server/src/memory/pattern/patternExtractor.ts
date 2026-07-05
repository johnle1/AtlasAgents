/**
 * <Summary>
 * What it does:
 *   Reads finished experience records and extracts reusable preference rules via
 *   the advisor model; always runs asynchronously after task finish.
 *
 * How it fits in the system:
 *   Triggered fire-and-forget by ExperienceRecorder.finish.
 * </Summary>
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
 * </Summary>
 */
export class PatternExtractor implements IPatternExtractor {
  /**
   * Constructor
   *
   * How it does it (step by step):
   *   1. Accept a dependency bag containing the three required services.
   *   2. Store the dependencies as private readonly fields for use in methods.
   *
   * Parameters:
   *   @param deps - Dependency bag with the following services:
   *     @param deps - .ollama — Client for communicating with the advisor AI model.
   *     @param deps - .config — Manager for reading configuration (model name, temperature).
   *     @param deps - .prefs — Store for persisting extracted preference rules.
   *
   * Returns:
   *   void — Constructor does not return a value.
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
   *   @param record - The finished experience to analyze.
   *
   * Returns:
   *   void — called for side effects only (background extraction).
   */
  extract = (record: ExperienceRecord): void => {
    // Step 1: Start the async work and attach error logging (fire-and-forget)
    // We intentionally don't await this promise because we want this to run
    // in the background without blocking the caller. The error handler ensures
    // that any failures are logged even though we're not awaiting the result.
    // The `void` prefix tells TypeScript and linters we're intentionally ignoring the promise.
    void this.run(record).catch((error) => {
      console.error("[PatternExtractor]", error);
    });
  };

  /**
   * @async
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
   *   @param record - The experience being processed.
   *
   * Returns:
   *   @returns Resolves when extraction and storage complete.
   *
   * Throws:
   *   - Errors from advisor chat are caught and logged, not re-thrown.
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

    // Step 2: Summarize files read/written, agent write diffs, escalations, user edits
    // This step builds a comprehensive but budgeted summary of the experience
    // that will be sent to the advisor model. Each section is carefully truncated
    // to avoid overwhelming the model while preserving the most relevant information.
    // The goal is to provide enough context for the advisor to extract meaningful rules
    // without exceeding context window limits or including irrelevant details.

    // Extract just the file paths (not full file objects) for read operations
    // This gives us context about what files the agent needed to understand
    // We use map to transform each fileEntry object into just its path string
    const readPaths = record.filesRead.map((fileEntry) => fileEntry.path);

    // Extract just the file paths for write operations
    // This shows what files the agent modified during the task
    // This helps the advisor understand which parts of the codebase were changed
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

    // Sample user edits to avoid overwhelming the advisor model
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

    // Add a note if we omitted any edits so the advisor knows the data is partial
    // This maintains transparency about the sampling process
    // It prevents the advisor from assuming it has seen all user corrections
    const editOmittedNote =
      omittedEdits > 0 ? `\n(... ${omittedEdits} more user edits omitted)` : "";

    // Step 3: Build user-visible prompt telling the advisor what to extract
    // This prompt provides the advisor model with a comprehensive summary of the
    // task experience and instructs it to extract general, reusable rules.
    // The prompt is structured to be human-readable for debugging and model-comprehensible.
    const advisorPrompt = [
      // Basic task information - what was attempted and how it turned out
      `Task: ${record.task}`,
      `Outcome: ${record.outcome ?? "unknown"}`,

      // File context - what files were involved in the task
      // This helps the advisor understand the scope and domain of the work
      `Files read: ${readPaths.length > 0 ? readPaths.join(", ") : "(none)"}`,
      `Files written (paths): ${writePaths.length > 0 ? writePaths.join(", ") : "(none)"}`,

      // Agent's actual changes - the diffs show what the agent did
      // This is crucial for understanding the agent's behavior and patterns
      `Agent writes (diffs):\n${agentWriteBlock.length > 0 ? agentWriteBlock : "(none)"}`,

      // Escalations - when the agent got stuck and needed help
      // These represent specific failure patterns that should be learned from
      `Escalations:\n${escalationBlock.length > 0 ? escalationBlock : "(none)"}`,

      // User corrections - what the user changed after the agent's work
      // These represent user preferences and style corrections
      `User edits after agent output:\n${editBlock.length > 0 ? editBlock + editOmittedNote : "(none)"}`,

      // Blank line for visual separation
      "",

      // The core question - asking the advisor to generalize from this specific experience
      "What general rules should be remembered from this experience to help with similar future tasks?",

      // Strict output format instructions - we need valid JSON, not conversational text
      // This ensures we can parse the response programmatically
      'Return ONLY a JSON array of objects with fields: text (string), topics (string[]), scope (string), confidence ("high"|"medium"|"low"). No markdown, no prose.',
    ].join("\n");

    // Step 4: Read model configuration and prepare chat messages
    // We need to configure the advisor model with the right parameters
    // The model name determines which AI model to use (e.g., llama2, mistral)
    // The temperature controls randomness (0.0 = deterministic, 1.0 = creative)
    const model = await this.deps.config.getAdvisorModel();
    const temperature = await this.deps.config.getAdvisorTemperature();

    // Construct the chat messages in the format expected by the Ollama client
    // The system message sets the persona and behavioral constraints
    // The user message contains the actual task and data to process
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
      // This is the core operation where we send the prompt to the AI model
      // and get back its analysis. We use the configured model and temperature.
      // The chat call may fail due to network issues or model errors, so it's wrapped in try-catch.
      // We await this call because we need the response before we can proceed with parsing.
      const rawAdvisorResponse = await this.deps.ollama.chat(model, messages, {
        temperature,
      });

      // Attempt to parse the JSON array from the advisor's response
      // The extractJsonArray helper extracts the JSON array from the raw response text
      // even if it's embedded in markdown code blocks or conversational text
      // This is necessary because LLMs often wrap JSON in markdown or add conversational filler
      let parsedRules: unknown;
      try {
        // First extract the JSON array string from the raw response
        // Then parse it as JSON to get a JavaScript object/array
        parsedRules = JSON.parse(
          extractJsonArray(rawAdvisorResponse),
        ) as unknown;
      } catch {
        // If parsing fails, log and continue to handle escalations/edits
        // This is a graceful failure - we still want to process escalations and user edits
        // even if the advisor's JSON output was malformed or missing
        // We set parsedRules to null to indicate the parsing failed
        console.error("[PatternExtractor] invalid JSON from advisor");
        parsedRules = null;
      }

      // Step 6: If the advisor returned a JSON array, validate and store
      // We validate each rule to ensure it meets our minimum requirements
      // This prevents malformed or empty rules from being stored
      // Validation is crucial because the advisor output is untrusted and could be malformed
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
      // If the advisor chat fails (network error, model unavailable, etc.),
      // we log the error but continue to process escalations and user edits.
      // This ensures we still capture some learning data even if the AI analysis fails.
      // We don't re-throw because this is a background process and failures shouldn't crash the system
      console.error("[PatternExtractor] advisor chat failed:", error);
    }

    // Step 7a: Convert recorded escalations into high-confidence fix rules
    // Escalations represent specific failure patterns where the agent needed help.
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
        // Unlike general advisor suggestions, escalation guidance comes from human intervention
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
