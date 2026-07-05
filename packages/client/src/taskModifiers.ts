import { loadConfig } from "./config.js";

/**
 * Trigger word configuration for controlling agent concurrency.
 *
 * @remarks
 * Users can append these trigger words to tasks to control how many agents
 * work simultaneously. Each trigger word maps to a specific maxAgents setting
 * and a human-readable label for display.
 *
 * - `::focus` — Single agent (maxAgents: 1)
 * - `::collab` — Two agents (maxAgents: 2)
 * - `::max` — Unlimited agents (maxAgents: "max")
 *
 * @example
 * ```ts
 * const modifiers = parseTaskModifiers("fix bug ::focus");
 * console.log(modifiers.maxAgents); // 1
 * ```
 */
export const TRIGGER_WORDS = {
  "::focus": { maxAgents: 1 as const, label: "focus mode" },
  "::collab": { maxAgents: 2 as const, label: "collab mode" },
  "::max": { maxAgents: "max" as const, label: "max mode" },
} as const;

/**
 * Union type of all valid trigger word keys.
 *
 * @remarks
 * This type represents the string literal types of all trigger word keys
 * defined in TRIGGER_WORDS. Used for type-safe trigger word lookups.
 */
export type TriggerWord = keyof typeof TRIGGER_WORDS;

/**
 * Allowed values for the maxAgents parameter.
 *
 * @remarks
 * Controls how many agents can work on a task simultaneously:
 * - `1` — Single agent (focus mode)
 * - `2` — Two agents (collab mode)
 * - `"max"` — Unlimited agents
 * - `number` — Custom agent count from config
 */
export type MaxAgentsParam = 1 | 2 | "max" | number;

/**
 * Result of parsing a task string for trigger words.
 *
 * @remarks
 * Contains the cleaned task text with trigger words removed, along with
 * extracted modifier settings like agent concurrency and mode label.
 *
 * @example
 * ```ts
 * const modifiers = parseTaskModifiers("deploy app ::collab");
 * console.log(modifiers.clean); // "deploy app"
 * console.log(modifiers.maxAgents); // 2
 * console.log(modifiers.modeLabel); // "collab mode"
 * ```
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

// Array of all trigger word keys for iteration
const TRIGGER_LIST = Object.keys(TRIGGER_WORDS) as TriggerWord[];

/**
 * Checks if a trigger word appears as a whole word in the task text.
 *
 * @remarks
 * Verifies word boundaries to ensure the trigger word is not matched as a
 * substring of another word. For example, `::focus` matches "test ::focus here"
 * but not "test::focushere".
 *
 * @param raw - The raw task text to search in.
 * @param word - The trigger word to look for.
 * @returns True if word appears as a whole word, false otherwise.
 */
const isWordBoundaryTrigger = (raw: string, word: TriggerWord): boolean => {
  let searchIndex = 0;

  while (searchIndex < raw.length) {
    const foundIndex = raw.indexOf(word, searchIndex);

    if (foundIndex === -1) {
      return false;
    }

    const characterBefore = foundIndex > 0 ? raw[foundIndex - 1] : " ";
    const characterAfter =
      foundIndex + word.length < raw.length
        ? raw[foundIndex + word.length]
        : " ";

    const isValidBoundaryBefore =
      characterBefore === " " || characterBefore === "\t" || foundIndex === 0;
    const isValidBoundaryAfter =
      characterAfter === " " ||
      characterAfter === "\t" ||
      foundIndex + word.length === raw.length;

    if (isValidBoundaryBefore && isValidBoundaryAfter) {
      return true;
    }

    // Move past this occurrence to check for next one (handles "::focus::focus")
    searchIndex = foundIndex + 1;
  }

  return false;
};

/**
 * Counts how many trigger words appear as whole words in the task text.
 *
 * @remarks
 * Used to detect if a task contains multiple trigger words, which may
 * indicate user confusion or an intentional override pattern.
 *
 * @param raw - The raw task text to count triggers in.
 * @returns The number of trigger words found as whole words.
 *
 * @example
 * ```ts
 * countTriggers("fix bug ::focus"); // 1
 * countTriggers("fix bug ::focus ::collab"); // 2
 * countTriggers("fix bug"); // 0
 * ```
 */
export const countTriggers = (raw: string): number =>
  TRIGGER_LIST.filter((triggerWord) => isWordBoundaryTrigger(raw, triggerWord))
    .length;

/**
 * Parses a task string to extract trigger word modifiers.
 *
 * @remarks
 * Searches for trigger words in priority order and extracts the first match.
 * Removes the trigger word from the task text and normalizes whitespace.
 * If no trigger word is found, returns default settings from config.
 *
 * @param raw - The raw task text that may contain trigger words.
 * @returns Object with maxAgents, modeLabel, clean text, and triggerFound fields.
 *
 * @example
 * ```ts
 * const modifiers = parseTaskModifiers("deploy app ::collab");
 * console.log(modifiers.clean); // "deploy app"
 * console.log(modifiers.maxAgents); // 2
 * console.log(modifiers.modeLabel); // "collab mode"
 * console.log(modifiers.triggerFound); // "::collab"
 * ```
 */
export const parseTaskModifiers = (raw: string): TaskModifiers => {
  for (const triggerWord of TRIGGER_LIST) {
    if (!isWordBoundaryTrigger(raw, triggerWord)) {
      continue;
    }

    const triggerConfig = TRIGGER_WORDS[triggerWord];
    return {
      maxAgents: triggerConfig.maxAgents,
      modeLabel: triggerConfig.label,
      // Remove trigger word and collapse multiple spaces
      clean: raw.replace(triggerWord, "").replace(/\s+/g, " ").trim(),
      triggerFound: triggerWord,
    };
  }

  // No trigger word found: use default config settings
  return {
    maxAgents: loadConfig().agentCap,
    modeLabel: null,
    clean: raw,
    triggerFound: null,
  };
};

/**
 * Formats a human-readable notice string showing the current mode and agent concurrency.
 *
 * @remarks
 * Returns null if no trigger word was found (modeLabel is null). Otherwise,
 * formats a notice with the mode label and agent count description.
 *
 * @param modifiers - The parsed task modifiers object.
 * @returns Formatted notice string, or null if no mode.
 *
 * @example
 * ```ts
 * formatModeNotice(parseTaskModifiers("fix bug ::focus"));
 * // "◎ focus mode — 1 agent"
 * formatModeNotice(parseTaskModifiers("fix bug ::max"));
 * // "◎ max mode — no agent cap"
 * formatModeNotice(parseTaskModifiers("fix bug"));
 * // null
 * ```
 */
export const formatModeNotice = (modifiers: TaskModifiers): string | null => {
  if (!modifiers.modeLabel) {
    return null;
  }

  if (modifiers.maxAgents === "max") {
    return `◎ ${modifiers.modeLabel} — no agent cap`;
  }

  const agentCountText =
    modifiers.maxAgents === 1
      ? "1 agent"
      : modifiers.maxAgents === 2
        ? "2 agents"
        : "advisor decides";

  return `◎ ${modifiers.modeLabel} — ${agentCountText}`;
};
