import type { Config } from "../config.js";
import type { MemoryEntry } from "../connection/index.js";
import { getTheme } from "../theme/themeManager.js";
import { THEMES } from "../theme/themes.js";
import { appendStyledLines } from "./sink.js";

/**
 * <Summary>
 * What it does:
 *   Formats a secret value for safe display by showing only the last few characters.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Trim the secret value to remove leading/trailing whitespace.
 *   3. If the secret is empty, return a "(not set)" message with secondary styling.
 *   4. If the secret is 4 characters or less, return "****" with secondary styling.
 *   5. Otherwise, return the last 4 characters with an ellipsis prefix and secondary styling.
 *
 * Parameters:
 *   @param {string} secret — The secret value to format (e.g., password, API key).
 *
 * Returns:
 *   @returns {string} — The formatted secret string with theme styling applied.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *
 * Dependants:
 *   - buildConfigLines — uses this to safely display the password configuration.
 * </Summary>
 */
const formatSecretDisplay = (secret: string): string => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Trim secret value =====
  // Step 2a: Remove leading and trailing whitespace from the secret
  const trimmedSecret = secret.trim();

  // ===== STEP 3: Handle empty secret =====
  // Step 3a: If the secret is empty after trimming, show "(not set)" message
  // Step 3b: Use secondary text color to indicate it's a placeholder
  if (!trimmedSecret) {
    return `${theme.textSecondary}(not set)${theme.reset}`;
  }

  // ===== STEP 4: Handle short secrets =====
  // Step 4a: If the secret is 4 characters or less, show "****" to hide the entire value
  // Step 4b: This prevents any part of a very short secret from being exposed
  if (trimmedSecret.length <= 4) {
    return `${theme.textSecondary}****${theme.reset}`;
  }

  // ===== STEP 5: Handle normal secrets =====
  // Step 5a: For longer secrets, show an ellipsis followed by the last 4 characters
  // Step 5b: This provides a visual indicator that a value is set without exposing the full secret
  // Step 5c: The last 4 characters can help users identify which secret is being referenced
  return `${theme.textSecondary}…${theme.reset}${trimmedSecret.slice(-4)}`;
};

/**
 * <Summary>
 * What it does:
 *   Builds an array of styled strings representing the current configuration.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Resolve the theme name from the theme identifier or use the identifier as fallback.
 *   3. Determine the spinner display state (on/off).
 *   4. Build the header line with bold styling.
 *   5. Build a separator line with repeated characters.
 *   6. Build individual configuration lines with appropriate styling and formatting.
 *   7. Handle optional model values with fallback to "(not set)" message.
 *   8. Return the complete array of styled lines.
 *
 * Parameters:
 *   @param {Config} config — The configuration object containing all settings.
 *
 * Returns:
 *   @returns {string[]} — Array of styled strings ready for display.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - THEMES — provides theme name lookup.
 *   - formatSecretDisplay — safely formats the password for display.
 *
 * Dependants:
 *   - printConfig — calls this to get the lines for configuration display.
 * </Summary>
 */
export const buildConfigLines = (config: Config): string[] => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Resolve theme name =====
  // Step 2a: Look up the theme name from the theme identifier
  // Step 2b: If the theme identifier is not in the THEMES object, use the identifier itself
  const resolvedThemeName = THEMES[config.ui.theme]?.name ?? config.ui.theme;

  // ===== STEP 3: Determine spinner state =====
  // Step 3a: Check if spinner is explicitly disabled, otherwise default to "on"
  const spinnerState = config.ui.showSpinner !== false ? "on" : "off";

  // ===== STEP 4: Build configuration lines array =====
  // Step 4a: Return an array of styled strings representing the configuration
  return [
    // ===== STEP 4b: Header line =====
    // Step 4b-1: Bold header text for the configuration section
    `${theme.textBold}  Current Configuration${theme.reset}`,

    // ===== STEP 4c: Separator line =====
    // Step 4c-1: Decorative separator line using repeated dash characters
    `${theme.textSecondary}  ${"─".repeat(34)}${theme.reset}`,

    // ===== STEP 4d: Configuration values =====
    // Step 4d-1: Server address with accent styling
    `  ${theme.textAccent}server${theme.reset}         ${config.server}`,

    // Step 4d-2: Port number with accent styling
    `  ${theme.textAccent}port${theme.reset}           ${config.port}`,

    // Step 4d-3: Password with safe formatting (only shows last 4 characters)
    `  ${theme.textAccent}password${theme.reset}       ${formatSecretDisplay(config.password)}`,

    // Step 4d-4: Advisor model with fallback to "(not set)" if not configured
    `  ${theme.textAccent}advisor model${theme.reset}  ${config.advisorModel || theme.textSecondary + "(not set)" + theme.reset}`,

    // Step 4d-5: Agent model with fallback to "(not set)" if not configured
    `  ${theme.textAccent}agent model${theme.reset}    ${config.agentModel || theme.textSecondary + "(not set)" + theme.reset}`,

    // Step 4d-6: Agent capability with usage hint
    `  ${theme.textAccent}agent cap${theme.reset}      ${config.agentCap} (/agent cap, ::max for no cap)`,

    // Step 4d-7: UI theme with both resolved name and theme identifier
    `  ${theme.textAccent}ui.theme${theme.reset}       ${resolvedThemeName} (${config.ui.theme})`,

    // Step 4d-8: Think output setting with command hint
    `  ${theme.textAccent}show think${theme.reset}     ${config.showThinkOutput ? "on" : "off"} (/think on|off)`,

    // Step 4d-9: Spinner setting
    `  ${theme.textAccent}show spinner${theme.reset}   ${spinnerState}`,
  ];
};

/**
 * <Summary>
 * What it does:
 *   Builds an array of styled strings listing available models for a specific category.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Build the header line with the category label.
 *   3. Add a blank line for spacing.
 *   4. Iterate through the models array and build numbered lines for each model.
 *   5. Use padding to align the numbers and apply warning color for visibility.
 *   6. Add a trailing blank line for spacing.
 *   7. Return the complete array of styled lines.
 *
 * Parameters:
 *   @param {string[]} models — Array of model names to display.
 *   @param {string} label — Category label for the models (e.g., "advisor", "agent").
 *
 * Returns:
 *   @returns {string[]} — Array of styled strings ready for display.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *
 * Dependants:
 *   - printModels — calls this to get the lines for model display.
 * </Summary>
 */
const buildModelsLines = (models: string[], label: string): string[] => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Initialize lines array with header =====
  // Step 2a: Create array with header line showing the category label
  // Step 2b: Add a blank line after the header for spacing
  const modelLines = [
    `${theme.textBold}  Available models for ${label}:${theme.reset}`,
    "",
  ];

  // ===== STEP 3: Build numbered model lines =====
  // Step 3a: Iterate through the models array with index
  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    // Step 3b: Build a line with the model number (1-indexed for user-friendliness)
    // Step 3c: Use padStart(3) to right-align numbers in a 3-character field
    // Step 3d: Apply warning color to the number for visibility
    // Step 3e: Add the model name after the number with spacing
    modelLines.push(
      `  ${theme.warning}${String(modelIndex + 1).padStart(3)}${theme.reset}  ${models[modelIndex]}`,
    );
  }

  // ===== STEP 4: Add trailing spacing =====
  // Step 4a: Add a blank line at the end for proper spacing
  modelLines.push("");

  // ===== STEP 5: Return complete lines =====
  // Step 5a: Return the array of styled lines for display
  return modelLines;
};

/**
 * <Summary>
 * What it does:
 *   Builds an array of styled strings listing available skills.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Check if the skills array is empty.
 *   3. If empty, return a message indicating no skills with a creation hint.
 *   4. If not empty, build the header line with the skill count.
 *   5. Add a blank line for spacing.
 *   6. Iterate through the skill names and build bullet-point lines for each.
 *   7. Apply accent color to the bullet point for visual emphasis.
 *   8. Add a trailing blank line for spacing.
 *   9. Return the complete array of styled lines.
 *
 * Parameters:
 *   @param {string[]} names — Array of skill names to display.
 *
 * Returns:
 *   @returns {string[]} — Array of styled strings ready for display.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *
 * Dependants:
 *   - printSkills — calls this to get the lines for skill display.
 * </Summary>
 */
const buildSkillsLines = (names: string[]): string[] => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Handle empty skills list =====
  // Step 2a: Check if there are no skills in the array
  if (names.length === 0) {
    // Step 2b: Return a message indicating no skills with a hint on how to create one
    return [
      `${theme.textSecondary}  No skills found. Use /skills add <name> to create one.${theme.reset}`,
      "",
    ];
  }

  // ===== STEP 3: Initialize lines array with header =====
  // Step 3a: Create array with header line showing the skill count
  // Step 3b: Add a blank line after the header for spacing
  const skillLines = [
    `${theme.textBold}  Skills (${names.length}):${theme.reset}`,
    "",
  ];

  // ===== STEP 4: Build skill name lines =====
  // Step 4a: Iterate through the skill names
  for (const skillName of names) {
    // Step 4b: Build a line with a bullet point and the skill name
    // Step 4c: Apply accent color to the bullet point for visual emphasis
    skillLines.push(`  ${theme.textAccent}•${theme.reset} ${skillName}`);
  }

  // ===== STEP 5: Add trailing spacing =====
  // Step 5a: Add a blank line at the end for proper spacing
  skillLines.push("");

  // ===== STEP 6: Return complete lines =====
  // Step 6a: Return the array of styled lines for display
  return skillLines;
};

/**
 * <Summary>
 * What it does:
 *   Builds an array of styled strings listing stored memory entries.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Check if the memory entries array is empty.
 *   3. If empty, return a message indicating no memories are stored.
 *   4. If not empty, build the header line with the topic count.
 *   5. Add a blank line for spacing.
 *   6. Iterate through the memory entries.
 *   7. For each entry, build a line with the topic name.
 *   8. For each rule in the entry, build an indented line with the rule content.
 *   9. Add a trailing blank line for spacing.
 *   10. Return the complete array of styled lines.
 *
 * Parameters:
 *   @param {MemoryEntry[]} entries — Array of memory entries to display.
 *
 * Returns:
 *   @returns {string[]} — Array of styled strings ready for display.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *
 * Dependants:
 *   - printMemory — calls this to get the lines for memory display.
 * </Summary>
 */
const buildMemoryLines = (entries: MemoryEntry[]): string[] => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Handle empty memory list =====
  // Step 2a: Check if there are no memory entries
  if (entries.length === 0) {
    // Step 2b: Return a message indicating no memories are stored
    return [`${theme.textSecondary}  No memories stored.${theme.reset}`, ""];
  }

  // ===== STEP 3: Initialize lines array with header =====
  // Step 3a: Create array with header line showing the topic count
  // Step 3b: Add a blank line after the header for spacing
  const memoryLines = [
    `${theme.textBold}  Stored Memories (${entries.length} topics):${theme.reset}`,
    "",
  ];

  // ===== STEP 4: Build memory entry lines =====
  // Step 4a: Iterate through the memory entries
  for (const memoryEntry of entries) {
    // ===== STEP 4b: Add topic line =====
    // Step 4b-1: Build a line with the topic name
    // Step 4b-2: Apply accent color to the topic for emphasis
    memoryLines.push(`  ${theme.textAccent}${memoryEntry.topic}${theme.reset}`);

    // ===== STEP 4c: Add rule lines =====
    // Step 4c-1: Iterate through the rules in this memory entry
    for (const rule of memoryEntry.rules) {
      // Step 4c-2: Build an indented line with the rule content
      // Step 4c-3: Use secondary color and arrow for visual hierarchy
      memoryLines.push(`    ${theme.textSecondary}→${theme.reset} ${rule}`);
    }
  }

  // ===== STEP 5: Add trailing spacing =====
  // Step 5a: Add a blank line at the end for proper spacing
  memoryLines.push("");

  // ===== STEP 6: Return complete lines =====
  // Step 6a: Return the array of styled lines for display
  return memoryLines;
};

/**
 * <Summary>
 * What it does:
 *   Displays the current configuration to the user.
 *
 * How it does it (step by step):
 *   1. Build the configuration lines using the buildConfigLines function.
 *   2. Append the styled lines to the output sink for display.
 *
 * Parameters:
 *   @param {Config} config — The configuration object to display.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the configuration.
 *
 * Dependencies:
 *   - buildConfigLines — generates the styled configuration lines.
 *   - appendStyledLines — displays the styled lines to the user.
 *
 * Dependants:
 *   - Configuration commands — use this to display current settings.
 * </Summary>
 */
export const printConfig = (config: Config): void => {
  // ===== STEP 1: Build configuration lines =====
  // Step 1a: Call buildConfigLines to generate the styled configuration display
  const configLines = buildConfigLines(config);

  // ===== STEP 2: Display configuration =====
  // Step 2a: Append the styled lines to the output sink for display to the user
  appendStyledLines(configLines);
};

/**
 * <Summary>
 * What it does:
 *   Displays available models for a specific category to the user.
 *
 * How it does it (step by step):
 *   1. Build the models lines using the buildModelsLines function.
 *   2. Append the styled lines to the output sink with blank lines before and after.
 *
 * Parameters:
 *   @param {string[]} models — Array of model names to display.
 *   @param {string} label — Category label for the models (e.g., "advisor", "agent").
 *
 * Returns:
 *   @returns {void} — Returns after displaying the models.
 *
 * Dependencies:
 *   - buildModelsLines — generates the styled models lines.
 *   - appendStyledLines — displays the styled lines to the user.
 *
 * Dependants:
 *   - Model listing commands — use this to display available models.
 * </Summary>
 */
export const printModels = (models: string[], label: string): void => {
  // ===== STEP 1: Build models lines =====
  // Step 1a: Call buildModelsLines to generate the styled models display
  const modelsLines = buildModelsLines(models, label);

  // ===== STEP 2: Display models with spacing =====
  // Step 2a: Append the styled lines with blank lines before and after for visual separation
  appendStyledLines(modelsLines, {
    leadingBlank: true,
    trailingBlank: true,
  });
};

/**
 * <Summary>
 * What it does:
 *   Displays available skills to the user.
 *
 * How it does it (step by step):
 *   1. Build the skills lines using the buildSkillsLines function.
 *   2. Append the styled lines to the output sink with blank lines before and after.
 *
 * Parameters:
 *   @param {string[]} names — Array of skill names to display.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the skills.
 *
 * Dependencies:
 *   - buildSkillsLines — generates the styled skills lines.
 *   - appendStyledLines — displays the styled lines to the user.
 *
 * Dependants:
 *   - Skill listing commands — use this to display available skills.
 * </Summary>
 */
export const printSkills = (names: string[]): void => {
  // ===== STEP 1: Build skills lines =====
  // Step 1a: Call buildSkillsLines to generate the styled skills display
  const skillsLines = buildSkillsLines(names);

  // ===== STEP 2: Display skills with spacing =====
  // Step 2a: Append the styled lines with blank lines before and after for visual separation
  appendStyledLines(skillsLines, {
    leadingBlank: true,
    trailingBlank: true,
  });
};

/**
 * <Summary>
 * What it does:
 *   Displays stored memory entries to the user.
 *
 * How it does it (step by step):
 *   1. Build the memory lines using the buildMemoryLines function.
 *   2. Append the styled lines to the output sink with blank lines before and after.
 *
 * Parameters:
 *   @param {MemoryEntry[]} entries — Array of memory entries to display.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the memories.
 *
 * Dependencies:
 *   - buildMemoryLines — generates the styled memory lines.
 *   - appendStyledLines — displays the styled lines to the user.
 *
 * Dependants:
 *   - Memory listing commands — use this to display stored memories.
 * </Summary>
 */
export const printMemory = (entries: MemoryEntry[]): void => {
  // ===== STEP 1: Build memory lines =====
  // Step 1a: Call buildMemoryLines to generate the styled memory display
  const memoryLines = buildMemoryLines(entries);

  // ===== STEP 2: Display memories with spacing =====
  // Step 2a: Append the styled lines with blank lines before and after for visual separation
  appendStyledLines(memoryLines, {
    leadingBlank: true,
    trailingBlank: true,
  });
};
