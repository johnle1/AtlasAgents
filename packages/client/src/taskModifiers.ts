import { loadConfig } from "./config.js";

/**
 * <Summary>
 * What it does:
 *   Defines trigger words that users can append to tasks to control agent
 *   concurrency and execution mode.
 *
 * Used by:
 *   - parseTaskModifiers — looks up trigger word configuration.
 *   - countTriggers — iterates over available trigger words.
 * </Summary>
 */
export const TRIGGER_WORDS = {
  "::focus": { maxAgents: 1 as const, label: "focus mode" },
  "::collab": { maxAgents: 2 as const, label: "collab mode" },
  "::max": { maxAgents: "max" as const, label: "max mode" },
} as const;

/**
 * <Summary>
 * What it does:
 *   Union type of all valid trigger word keys.
 *
 * Used by:
 *   - isWordBoundaryTrigger — parameter type for word to search for.
 *   - parseTaskModifiers — iterates over these values.
 * </Summary>
 */
export type TriggerWord = keyof typeof TRIGGER_WORDS;

/**
 * <Summary>
 * What it does:
 *   Allowed values for the maxAgents parameter, controlling how many
 *   agents can work on a task simultaneously.
 *
 * Used by:
 *   - TaskModifiers.maxAgents — field type.
 *   - Connection.sendTask — passed as maxAgents parameter.
 * </Summary>
 */
export type MaxAgentsParam = 1 | 2 | "max" | number;

/**
 * <Summary>
 * What it does:
 *   Result of parsing a task string for trigger words, containing the
 *   cleaned task text and extracted modifier settings.
 *
 * Used by:
 *   - parseTaskModifiers — returned as the result type.
 *   - formatModeNotice — uses modeLabel and maxAgents for display.
 *   - Connection.sendTask — uses maxAgents from this object.
 *
 * Properties:
 *   - maxAgents: The agent concurrency setting (1, 2, "max", or number).
 *   - modeLabel: Human-readable mode name for display, or null if no trigger.
 *   - clean: The task text with trigger word removed and whitespace normalized.
 *   - triggerFound: The trigger word that was found, or null if none.
 * </Summary>
 */
export type TaskModifiers = {
  /** Agent concurrency setting extracted from trigger word or config default. */
  maxAgents: MaxAgentsParam;

  /** Human-readable mode label for UI display, null if no trigger found. */
  modeLabel: string | null;

  /** Task text with trigger word removed and extra whitespace collapsed. */
  clean: string;

  /** The trigger word key that was found in the task, or null if none. */
  triggerFound: TriggerWord | null;
};

/**
 * <Summary>
 * What it does:
 *   Array of all trigger word keys for iteration.
 *
 * Used by:
 *   - countTriggers — iterates to count matches.
 *   - parseTaskModifiers — iterates to find first match.
 * </Summary>
 */
const TRIGGER_LIST = Object.keys(TRIGGER_WORDS) as TriggerWord[];

/**
 * <Summary>
 * What it does:
 *   Checks if a trigger word appears as a whole word (not as a substring)
 *   in the raw task text by verifying word boundaries.
 *
 * How it does it (step by step):
 *   1. Start searching from the beginning of the string.
 *   2. Find the next occurrence of the trigger word.
 *   3. If not found, return false (word not present).
 *   4. Check the character before the word is a space, tab, or string start.
 *   5. Check the character after the word is a space, tab, or string end.
 *   6. If both boundaries are valid, return true (whole word match).
 *   7. Otherwise, continue searching from the next position.
 *   8. If no whole word match found after full scan, return false.
 *
 * Parameters:
 *   @param raw - The raw task text to search in.
 *   @param word - The trigger word to look for.
 *
 * Returns:
 *   @returns True if word appears as a whole word, false otherwise.
 * </Summary>
 */
const isWordBoundaryTrigger = (raw: string, word: TriggerWord): boolean => {
  // ===== STEP 1: Initialize Search Position =====
  // Step 1a: Start searching from the beginning of the string
  let searchIndex = 0;

  // ===== STEP 2: Search Through String =====
  // Step 2a: Loop until we've scanned the entire string
  while (searchIndex < raw.length) {
    // ===== STEP 2b: Find Next Occurrence =====
    // Step 2b-i: Search for the trigger word starting from current position
    const foundIndex = raw.indexOf(word, searchIndex);

    // Step 2b-ii: If word not found at all, return false
    if (foundIndex === -1) {
      return false;
    }

    // ===== STEP 2c: Check Word Boundaries =====
    // Step 2c-i: Get character before the word (or space if at start)
    const characterBefore = foundIndex > 0 ? raw[foundIndex - 1] : " ";

    // Step 2c-ii: Get character after the word (or space if at end)
    const characterAfter =
      foundIndex + word.length < raw.length
        ? raw[foundIndex + word.length]
        : " ";

    // Step 2c-iii: Check if before boundary is valid (space, tab, or string start)
    const isValidBoundaryBefore =
      characterBefore === " " || characterBefore === "\t" || foundIndex === 0;

    // Step 2c-iv: Check if after boundary is valid (space, tab, or string end)
    const isValidBoundaryAfter =
      characterAfter === " " ||
      characterAfter === "\t" ||
      foundIndex + word.length === raw.length;

    // ===== STEP 2d: Check for Whole Word Match =====
    // Step 2d-i: If both boundaries are valid, this is a whole word match
    if (isValidBoundaryBefore && isValidBoundaryAfter) {
      return true;
    }

    // ===== STEP 2e: Continue Search =====
    // Step 2e-i: Move search position past this occurrence to find next one
    // This handles cases like "::focus::focus" where word appears multiple times
    searchIndex = foundIndex + 1;
  }

  // ===== STEP 3: No Whole Word Match Found =====
  // Step 3a: Return false after scanning entire string without finding whole word
  return false;
};

/**
 * <Summary>
 * What it does:
 *   Counts how many trigger words appear as whole words in the task text.
 *
 * How it does it (step by step):
 *   1. Iterate through all trigger words in TRIGGER_LIST.
 *   2. For each trigger word, check if it appears as a whole word.
 *   3. Count the number of trigger words that match.
 *   4. Return the total count.
 *
 * Parameters:
 *   @param raw - The raw task text to count triggers in.
 *
 * Returns:
 *   @returns The number of trigger words found as whole words.
 * </Summary>
 */
export const countTriggers = (raw: string): number =>
  TRIGGER_LIST.filter((triggerWord) => isWordBoundaryTrigger(raw, triggerWord))
    .length;

/**
 * <Summary>
 * What it does:
 *   Parses a task string to extract trigger word modifiers and returns
 *   the cleaned task text with agent concurrency settings.
 *
 * How it does it (step by step):
 *   1. Iterate through all trigger words in priority order.
 *   2. For each trigger word, check if it appears as a whole word in the task.
 *   3. If a trigger word is found, extract its configuration.
 *   4. Remove the trigger word from the task text.
 *   5. Collapse multiple spaces into single spaces and trim.
 *   6. Return modifiers with maxAgents, modeLabel, clean text, and trigger.
 *   7. If no trigger word found, return default config settings.
 *
 * Parameters:
 *   @param raw - The raw task text that may contain trigger words.
 *
 * Returns:
 *   @returns Object with maxAgents, modeLabel, clean text,
 *                              and triggerFound fields.
 * </Summary>
 */
export const parseTaskModifiers = (raw: string): TaskModifiers => {
  // ===== STEP 1: Search for Trigger Words =====
  // Step 1a: Iterate through all trigger words in order
  for (const triggerWord of TRIGGER_LIST) {
    // Step 1b: Check if this trigger word appears as a whole word
    if (!isWordBoundaryTrigger(raw, triggerWord)) {
      // Step 1c: If not found, skip to next trigger word
      continue;
    }

    // ===== STEP 2: Extract Trigger Configuration =====
    // Step 2a: Get the configuration for this trigger word
    const triggerConfig = TRIGGER_WORDS[triggerWord];

    // ===== STEP 3: Build Modifiers Object =====
    // Step 3a: Return modifiers with extracted settings
    return {
      // Step 3b: Use the maxAgents value from trigger configuration
      maxAgents: triggerConfig.maxAgents,

      // Step 3c: Use the mode label from trigger configuration
      modeLabel: triggerConfig.label,

      // Step 3d: Remove trigger word from task and normalize whitespace
      // First replace removes the trigger word, second collapses multiple spaces
      clean: raw.replace(triggerWord, "").replace(/\s+/g, " ").trim(),

      // Step 3e: Record which trigger word was found
      triggerFound: triggerWord,
    };
  }

  // ===== STEP 4: No Trigger Word Found =====
  // Step 4a: Return default modifiers using config settings
  return {
    // Step 4b: Use the default agent cap from config
    maxAgents: loadConfig().agentCap,

    // Step 4c: No mode label since no trigger was found
    modeLabel: null,

    // Step 4d: Return raw task text unchanged (no cleaning needed)
    clean: raw,

    // Step 4e: No trigger word was found
    triggerFound: null,
  };
};

/**
 * <Summary>
 * What it does:
 *   Formats a human-readable notice string showing the current mode
 *   and agent concurrency setting for display in the CLI.
 *
 * How it does it (step by step):
 *   1. Check if modeLabel is null (no trigger word found).
 *   2. If null, return null (no notice to display).
 *   3. If maxAgents is "max", format notice with "no agent cap".
 *   4. If maxAgents is 1, format notice with "1 agent".
 *   5. If maxAgents is 2, format notice with "2 agents".
 *   6. Otherwise, format notice with "advisor decides".
 *   7. Return the formatted notice string.
 *
 * Parameters:
 *   @param modifiers - The parsed task modifiers object.
 *
 * Returns:
 *   @returns Formatted notice string, or null if no mode.
 * </Summary>
 */
export const formatModeNotice = (modifiers: TaskModifiers): string | null => {
  // ===== STEP 1: Check for Mode Label =====
  // Step 1a: If no mode label, no notice to display
  if (!modifiers.modeLabel) {
    return null;
  }

  // ===== STEP 2: Handle Max Mode =====
  // Step 2a: If maxAgents is "max", show no agent cap notice
  if (modifiers.maxAgents === "max") {
    return `◎ ${modifiers.modeLabel} — no agent cap`;
  }

  // ===== STEP 3: Handle Numeric Agent Counts =====
  // Step 3a: Determine agent count text based on maxAgents value
  const agentCountText =
    modifiers.maxAgents === 1
      ? "1 agent"
      : modifiers.maxAgents === 2
        ? "2 agents"
        : "advisor decides";

  // ===== STEP 4: Return Formatted Notice =====
  // Step 4a: Build and return the complete notice string
  return `◎ ${modifiers.modeLabel} — ${agentCountText}`;
};
