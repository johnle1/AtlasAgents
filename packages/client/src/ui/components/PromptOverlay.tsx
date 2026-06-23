import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { resolvePrompt } from "../uiBridge.js";
import { THEMES } from "../../theme/themes.js";
import { setTheme } from "../../theme/themeManager.js";
import { useAppContext } from "../../DataContext.js";

/**
 * <Summary>
 * What it does:
 *   Renders the appropriate prompt overlay component based on the request type.
 *
 * How it does it (step by step):
 *   1. Check if a prompt request exists, return null if not.
 *   2. Switch on request type to determine which prompt component to render.
 *   3. For theme requests: render ThemePicker.
 *   4. For plan edit requests: render PlanEditPrompt.
 *   5. For choice requests: render ChoicePrompt.
 *   6. For other requests: render LinePrompt (with masking if specified).
 *
 * Parameters:
 *   None — uses promptReq from context.
 *
 * Returns:
 *   @returns The appropriate prompt component or null.
 * </Summary>
 */
export const PromptOverlay: React.FC = () => {
  const { promptReq } = useAppContext();

  // Don't render if no prompt request exists
  if (!promptReq) return null;
  const request = promptReq;

  // Render appropriate prompt based on request type
  if (request.type === "theme") {
    return <ThemePicker />;
  }
  if (request.type === "planEdit") {
    return <PlanEditPrompt initial={request.initial} />;
  }
  if (request.type === "choice") {
    return <ChoicePrompt prompt={request.prompt} max={request.max} />;
  }
  return (
    <LinePrompt prompt={request.prompt} masked={request.masked === true} />
  );
};

/**
 * <Summary>
 * What it does:
 *   Renders a single-line text input prompt with optional password masking.
 *
 * How it fits in the system:
 *   Used for simple text input prompts where the user provides a single
 *   line of text (e.g., passwords, configuration values).
 * </Summary>
 */
const LinePrompt: React.FC<{ prompt: string; masked: boolean }> = ({
  prompt,
  masked,
}) => {
  const { promptDraft, setPromptDraft } = useAppContext();
  return (
    <Box flexDirection="column">
      <Text>{prompt}</Text>
      <TextInput
        value={promptDraft.lineValue}
        onChange={(inputValue) =>
          setPromptDraft((previousDraft) => ({
            ...previousDraft,
            lineValue: inputValue,
          }))
        }
        mask={masked ? "*" : undefined}
        onSubmit={(submittedValue) => resolvePrompt(submittedValue)}
      />
    </Box>
  );
};

/**
 * <Summary>
 * What it does:
 *   Renders a numeric choice input prompt with validation.
 *
 * How it fits in the system:
 *   Used when the user needs to select from a numbered list of options.
 *   Validates that input is a number within the valid range.
 * </Summary>
 */
const ChoicePrompt: React.FC<{ prompt: string; max: number }> = ({
  prompt,
  max,
}) => {
  const { promptDraft, setPromptDraft } = useAppContext();
  return (
    <Box flexDirection="column">
      <Text>{prompt}</Text>
      <Text dimColor>Enter 1–{max}</Text>
      <TextInput
        value={promptDraft.choiceValue}
        onChange={(inputValue) =>
          setPromptDraft((previousDraft) => ({
            ...previousDraft,
            choiceValue: inputValue,
          }))
        }
        onSubmit={(submittedValue) => {
          // Parse input as number, default to 1 if invalid
          const parsedNumber = parseInt(submittedValue.trim(), 10);
          resolvePrompt(Number.isNaN(parsedNumber) ? 1 : parsedNumber);
        }}
      />
    </Box>
  );
};

/**
 * <Summary>
 * What it does:
 *   Renders a multi-line plan editing prompt with initial steps displayed.
 *
 * How it fits in the system:
 *   Used when the user wants to edit a generated plan. Shows initial
 *   plan steps and allows adding new steps line by line. An empty line
 *   submits the final plan.
 * </Summary>
 */
const PlanEditPrompt: React.FC<{ initial: string[] }> = ({ initial }) => {
  const { promptDraft, setPromptDraft } = useAppContext();

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Revise plan (empty line when done). Agent grouping will be recalculated.
      </Text>

      {/* ===== INITIAL PLAN STEPS ===== */}
      {initial.map((line, lineIndex) => (
        <Text key={`init-${lineIndex}`}>
          {lineIndex + 1}. {line}
        </Text>
      ))}

      {/* ===== NEWLY ADDED STEPS ===== */}
      {promptDraft.planLines.map((line, lineIndex) => (
        <Text key={`new-${lineIndex}`}>
          {initial.length + lineIndex + 1}. {line}
        </Text>
      ))}

      {/* ===== CURRENT INPUT LINE ===== */}
      <TextInput
        value={promptDraft.planCurrent}
        onChange={(inputValue) =>
          setPromptDraft((previousDraft) => ({
            ...previousDraft,
            planCurrent: inputValue,
          }))
        }
        onSubmit={(submittedValue) => {
          // Empty line submits the final plan
          if (submittedValue.trim().length === 0) {
            // Use edited lines if any, otherwise keep original
            const finalPlan =
              promptDraft.planLines.length > 0
                ? promptDraft.planLines
                : [...initial];
            resolvePrompt(finalPlan);
            return;
          }

          // Add non-empty line to plan and clear input
          setPromptDraft((previousDraft) => ({
            ...previousDraft,
            planLines: [...previousDraft.planLines, submittedValue.trim()],
            planCurrent: "",
          }));
        }}
      />
    </Box>
  );
};

/**
 * <Summary>
 * What it does:
 *   Renders an interactive theme selection menu with keyboard navigation.
 *
 * How it does it (step by step):
 *   1. Get list of available theme IDs from THEMES object.
 *   2. Track currently selected theme index.
 *   3. Handle keyboard input for navigation (up/down arrows) and selection (enter).
 *   4. Apply selected theme and close prompt on enter.
 *   5. Close prompt without changes on escape.
 *
 * Parameters:
 *   None — uses THEMES and context state.
 *
 * Returns:
 *   @returns Theme selection menu component.
 * </Summary>
 */
const ThemePicker: React.FC = () => {
  const { promptDraft, setPromptDraft } = useAppContext();

  // Get list of available theme IDs
  const themeIds = Object.keys(THEMES);

  // Track currently selected theme index
  const selectedIndex = promptDraft.themeSelected;

  // ===== KEYBOARD INPUT HANDLING =====
  useInput((_input, key) => {
    if (key.upArrow) {
      setPromptDraft((previousDraft) => ({
        ...previousDraft,
        themeSelected: Math.max(0, previousDraft.themeSelected - 1),
      }));
    }
    if (key.downArrow) {
      setPromptDraft((previousDraft) => ({
        ...previousDraft,
        themeSelected: Math.min(
          themeIds.length - 1,
          previousDraft.themeSelected + 1,
        ),
      }));
    }
    if (key.return) {
      // Apply selected theme and close prompt
      setTheme(themeIds[selectedIndex]! as keyof typeof THEMES);
      resolvePrompt(undefined);
    }
    if (key.escape) {
      // Close prompt without applying changes
      resolvePrompt(undefined);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Theme</Text>

      {/* ===== THEME OPTIONS ===== */}
      {themeIds.map((themeId, themeIndex) => (
        <Text
          key={`${themeId}-${themeIndex}`}
          bold={themeIndex === selectedIndex}
        >
          {themeIndex === selectedIndex ? "▸ " : "  "}
          {THEMES[themeId]?.name ?? themeId}
        </Text>
      ))}
    </Box>
  );
};
