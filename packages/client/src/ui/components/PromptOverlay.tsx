import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { resolvePrompt } from "../uiBridge.js";
import { THEMES } from "../../theme/themes.js";
import { setTheme } from "../../theme/themeManager.js";
import { useAppContext } from "../../DataContext.js";

/**
 * Router-style overlay component that selects and renders the active modal prompt based on the server request type.
 *
 * @remarks
 * Prompts are overlay boxes that block standard execution until user feedback is received.
 * Supported prompt types:
 * - `theme`: interactive color palette picker
 * - `planEdit`: step-by-step editor for plans
 * - `choice`: numeric multiple-choice index entry
 * - default: standard single-line string prompt (with optional password masking)
 *
 * @example
 * ```tsx
 * import React from "react";
 * import { render } from "ink";
 * import { PromptOverlay } from "./PromptOverlay.js";
 * 
 * // Note: Requires parent wrapper with active DataContext.
 * ```
 */
export const PromptOverlay: React.FC = () => {
  const { promptReq } = useAppContext();

  // Check if a prompt window is active. If not, yield execution.
  if (!promptReq) return null;
  const request = promptReq;

  // Route the render flow based on the request variant payload.
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
 * Renders a simple one-line textual input prompt (e.g., API keys, directory paths).
 *
 * @remarks
 * Supports a `masked` parameter which formats characters as asterisks for hidden credential inputs.
 *
 * @param props - Component parameters.
 * @param props.prompt - The question description string shown above the input cursor.
 * @param props.masked - Toggles character hidden masking for passwords or secure keys.
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
 * Renders a bounded multiple-choice index selection prompt.
 *
 * @remarks
 * Restricts inputs to integer selections between 1 and a specified upper bound.
 *
 * @param props - Component parameters.
 * @param props.prompt - Descriptive text showing the choice lists.
 * @param props.max - The maximum valid index number acceptable.
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
          // Convert input index to integer, falling back safely to 1 on NaN.
          const parsedNumber = parseInt(submittedValue.trim(), 10);
          resolvePrompt(Number.isNaN(parsedNumber) ? 1 : parsedNumber);
        }}
      />
    </Box>
  );
};

/**
 * Renders a multi-line editing interface for updating advisor plans prior to execution.
 *
 * @remarks
 * Displays the original plan, lists modified/new steps, and exposes a blank line
 * prompt to append more steps. Submitting an empty step commits the plan list back to IPC.
 *
 * @param props - Component parameters.
 * @param props.initial - Array of starting plan steps.
 */
const PlanEditPrompt: React.FC<{ initial: string[] }> = ({ initial }) => {
  const { promptDraft, setPromptDraft } = useAppContext();

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Revise plan (empty line when done). Agent grouping will be recalculated.
      </Text>

      {/* Render the baseline plan steps proposed by the advisor */}
      {initial.map((line, lineIndex) => (
        <Text key={`init-${lineIndex}`}>
          {lineIndex + 1}. {line}
        </Text>
      ))}

      {/* Render user-appended step overrides */}
      {promptDraft.planLines.map((line, lineIndex) => (
        <Text key={`new-${lineIndex}`}>
          {initial.length + lineIndex + 1}. {line}
        </Text>
      ))}

      {/* Active input field allowing the user to type the next plan step */}
      <TextInput
        value={promptDraft.planCurrent}
        onChange={(inputValue) =>
          setPromptDraft((previousDraft) => ({
            ...previousDraft,
            planCurrent: inputValue,
          }))
        }
        onSubmit={(submittedValue) => {
          // Empty string indicates completion. We submit the updated list, or fallback to the initial plan.
          if (submittedValue.trim().length === 0) {
            const finalPlan =
              promptDraft.planLines.length > 0
                ? promptDraft.planLines
                : [...initial];
            resolvePrompt(finalPlan);
            return;
          }

          // Append the newly written step and clear the buffer for the next input.
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
 * Renders a choice selector list for switching terminal color themes.
 *
 * @remarks
 * Binds `useInput` arrow controls to navigate themes, applying chosen colors
 * via the theme manager on pressing `return`, or cancelling on `escape`.
 */
const ThemePicker: React.FC = () => {
  const { promptDraft, setPromptDraft } = useAppContext();

  // Enumerate theme keys configured in the static theme catalog.
  const themeIds = Object.keys(THEMES);

  // Cursor position highlighting the theme index candidate.
  const selectedIndex = promptDraft.themeSelected;

  // Intercept keyboard events to override arrow-key controls for navigation.
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
      // Update theme preferences globally in storage and exit prompt.
      setTheme(themeIds[selectedIndex]! as keyof typeof THEMES);
      resolvePrompt(undefined);
    }
    if (key.escape) {
      // Dismiss prompt without saving the theme choice.
      resolvePrompt(undefined);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Theme</Text>

      {/* Render theme candidates with indicator arrows on the selected item */}
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
