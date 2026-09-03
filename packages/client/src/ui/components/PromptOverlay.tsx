import React from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { resolvePrompt } from "../uiBridge.js";
import { THEMES } from "../../theme/themes.js";
import { setTheme } from "../../theme/themeManager.js";
import { useAppContext } from "../../state/DataContext.js";
import {
  resolveOptionBarKey,
  computeVisibleWindow,
  computeOptionBarPointerOffset,
  optionBarLabelColor,
  OPTION_BAR_SEPARATOR,
  OPTION_BAR_LEFT_EDGE,
} from "./optionBarKeymap.js";

/**
 * Router-style overlay component that selects and renders the active modal prompt based on the server request type.
 *
 * @remarks
 * Prompts are overlay boxes that block standard execution until user feedback is received.
 * Supported prompt types:
 * - `theme`: interactive color palette picker
 * - `planFeedback`: free-text feedback box the agent re-plans from
 * - `choice`: numeric multiple-choice index entry
 * - `optionBar`: horizontal left/right-navigable option bar (`/model`, `/effort`)
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
  if (request.type === "planFeedback") {
    return <PlanFeedbackPrompt initial={request.initial} />;
  }
  if (request.type === "choice") {
    return <ChoicePrompt prompt={request.prompt} max={request.max} />;
  }
  if (request.type === "optionBar") {
    return (
      <OptionBarPrompt
        prompt={request.prompt}
        options={request.options}
        optionColors={request.optionColors}
      />
    );
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
 * Renders a free-text feedback box for revising a proposed plan.
 *
 * @remarks
 * Shows the proposed steps as read-only reference, then takes a single line
 * of feedback (e.g. "add error handling for the upload step") which is sent
 * back to the agent — the agent re-plans from this feedback; the user does
 * not hand-edit the plan text directly.
 *
 * @param props - Component parameters.
 * @param props.initial - Proposed plan steps shown for context.
 */
const PlanFeedbackPrompt: React.FC<{ initial: string[] }> = ({ initial }) => {
  const { promptDraft, setPromptDraft } = useAppContext();

  return (
    <Box flexDirection="column">
      <Text dimColor>What should change about this plan?</Text>

      {/* Render the proposed plan steps for reference while typing feedback */}
      {initial.map((line, lineIndex) => (
        <Text key={`init-${lineIndex}`} dimColor>
          {lineIndex + 1}. {line}
        </Text>
      ))}

      <TextInput
        value={promptDraft.lineValue}
        onChange={(inputValue) =>
          setPromptDraft((previousDraft) => ({
            ...previousDraft,
            lineValue: inputValue,
          }))
        }
        onSubmit={(submittedValue) => resolvePrompt(submittedValue.trim())}
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

/** Max options rendered at once — longer lists (e.g. `/model`) scroll instead of overflowing. */
const OPTION_BAR_WINDOW_SIZE = 5;

/**
 * Renders a horizontal, left/right-navigable option bar — the shared
 * picker behind both `/model` and `/effort`.
 *
 * @remarks
 * Binds `useInput` left/right controls to move the highlight (via
 * {@link resolveOptionBarKey}), confirming on `return` (resolves the
 * selected index) or cancelling on `escape` (resolves `undefined`, leaving
 * the caller's current value unchanged). Long option lists are windowed via
 * {@link computeVisibleWindow} so the bar never overflows terminal width;
 * `‹`/`›` mark truncated edges. A single `^` pointer renders on the line
 * below, centered under the selected label via
 * {@link computeOptionBarPointerOffset} — bold/color alone (the label's own
 * styling) can be too weak a signal in a limited-color terminal, so this
 * mirrors the `▸ ` glyph {@link ThemePicker}/`ApprovalMenu` use for the same
 * reason, adapted to a horizontal layout. The pointer re-centers on every
 * arrow move since it's derived straight from `selectedIndex`, not tracked
 * separately. The starting highlight is seeded from
 * `promptDraft.optionBarSelected`, which `DataContext`'s prompt-reset effect
 * sets to the request's `initialIndex` (the current model/effort) rather
 * than always starting at 0.
 *
 * @param props - Component parameters.
 * @param props.prompt - Question shown above the bar.
 * @param props.options - Display labels in order; the resolved value is the
 *   chosen label's index.
 * @param props.optionColors - Optional Ink palette; only the highlighted label is tinted.
 */
const OptionBarPrompt: React.FC<{
  prompt: string;
  options: string[];
  optionColors?: string[];
}> = ({ prompt, options, optionColors }) => {
  const { promptDraft, setPromptDraft } = useAppContext();
  const selectedIndex = promptDraft.optionBarSelected;

  useInput((_input, key) => {
    const action = resolveOptionBarKey(key, selectedIndex, options.length);
    if (action.type === "move") {
      setPromptDraft((previousDraft) => ({
        ...previousDraft,
        optionBarSelected: action.index,
      }));
    } else if (action.type === "confirm") {
      resolvePrompt(action.index);
    } else if (action.type === "dismiss") {
      resolvePrompt(undefined);
    }
  });

  const { indices, hasMore } = computeVisibleWindow(
    selectedIndex,
    options.length,
    OPTION_BAR_WINDOW_SIZE,
  );
  const visibleLabels = indices.map((optionIndex) => options[optionIndex]!);
  const selectedPosition = indices.indexOf(selectedIndex);
  const pointerColumn = computeOptionBarPointerOffset(
    visibleLabels,
    selectedPosition,
    hasMore.left,
  );

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{prompt}</Text>
      <Box flexDirection="row">
        {hasMore.left ? <Text dimColor>{OPTION_BAR_LEFT_EDGE}</Text> : null}
        {indices.map((optionIndex, position) => (
          <React.Fragment key={optionIndex}>
            {position > 0 ? (
              <Text dimColor>{OPTION_BAR_SEPARATOR}</Text>
            ) : null}
            <Text
              bold={optionIndex === selectedIndex}
              color={optionBarLabelColor(
                optionColors,
                optionIndex,
                selectedIndex,
              )}
            >
              {options[optionIndex]}
            </Text>
          </React.Fragment>
        ))}
        {hasMore.right ? <Text dimColor> ›</Text> : null}
      </Box>
      {/* Single centered pointer under the selected label — re-centers on
          every arrow move since it's derived straight from selectedIndex. */}
      <Text dimColor>{" ".repeat(pointerColumn)}^</Text>
      <Text dimColor>←/→ move · Enter confirm · Esc cancel</Text>
    </Box>
  );
};
