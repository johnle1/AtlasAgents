/**
 * <Summary>
 * What it does:
 *   Ink root application component — manages history display, spinner status, input handling, and approval menus.
 *
 * How it fits in the system:
 *   The top-level React component for the Ink-based CLI interface. It orchestrates all UI components
 *   including the banner, history view, status spinner, input box, approval menus, and command autocomplete.
 *   This is the entry point for the entire terminal UI.
 *
 * Dependencies:
 *   - React — provides the component framework.
 *   - Ink — provides terminal UI components (Box, Static, Text).
 *   - loadConfig — provides configuration for banner generation.
 *   - buildBannerLines — creates the ASCII art banner for display.
 *   - AppProvider — provides the application context for state management.
 *   - HistoryView — renders the scrollable history display.
 *   - StatusSpinner — renders the bottom-line status indicator.
 *   - InputBox — renders the user input field.
 *   - ApprovalMenu — renders command approval prompts.
 *   - PromptOverlay — renders file/skill input overlays.
 *   - commandCatalog — provides command descriptions and labels for autocomplete.
 *
 * Dependants:
 *   - Application entry point — renders this as the root component.
 * </Summary>
 */

import React, { useRef } from "react";
import { Box, Static, Text } from "ink";

import { loadConfig } from "../config.js";
import { buildBannerLines } from "../renderer/banner.js";
import type { AppProps } from "./types.js";
import { AppProvider, useAppContext } from "./AppContext.js";
import { HistoryView, renderHistoryItem } from "./components/HistoryView.js";
import { StatusSpinner } from "./components/Spinner.js";
import { InputBox } from "./components/InputBox.js";
import { ApprovalMenu } from "./components/ApprovalMenu.js";
import { PromptOverlay } from "./components/PromptOverlay.js";
import { getCommandDescription, getCommandLabel } from "./commandCatalog.js";

/**
 * <Summary>
 * What it does:
 *   Root Ink application component that sets up the application context and renders the main UI.
 *
 * How it does it (step by step):
 *   1. Build the banner lines from configuration.
 *   2. Transform banner lines into static entries with unique keys.
 *   3. Create a ref to hold the banner entries for stable reference.
 *   4. Render the AppProvider with banner entries and children.
 *   5. Render AppContent inside the provider.
 *
 * Parameters:
 * @param {AppProps} props — Application properties including connection, command handler, file proxy, etc.
 *
 * Returns:
 * @returns {JSX.Element} — The root application component with context provider.
 *
 * Dependencies:
 *   - useRef — provides stable reference for banner entries.
 *   - loadConfig — provides configuration for banner generation.
 *   - buildBannerLines — creates the ASCII art banner.
 *   - AppProvider — provides application context.
 *   - AppContent — renders the main application content.
 *
 * Dependants:
 *   - Application entry point — renders this as the root component.
 * </Summary>
 */
export const App: React.FC<AppProps> = (props) => {
  // ===== STEP 1: Build banner entries =====
  // Step 1a: Use useRef to maintain stable reference to banner entries across re-renders
  // Step 1b: Build banner lines from current configuration
  // Step 1c: Transform each line into a static entry with unique key and kind "banner"
  const bannerEntries = useRef(
    buildBannerLines(loadConfig()).map((bannerLine, lineIndex) => ({
      kind: "banner" as const,
      key: `banner-${lineIndex}`,
      line: bannerLine,
    })),
  ).current;

  // ===== STEP 2: Render application with context =====
  // Step 2a: Provide the app context with banner entries and pass through all props
  // Step 2b: Render AppContent as the main child component
  return (
    <AppProvider {...props} bannerEntries={bannerEntries}>
      <AppContent />
    </AppProvider>
  );
};

/**
 * <Summary>
 * What it does:
 *   Main application content component that renders all UI elements using the app context.
 *
 * How it does it (step by step):
 *   1. Extract state values and setters from the app context.
 *   2. Render the main layout box with column direction.
 *   3. Render the static entries (banner and history) using the Static component.
 *   4. Render the history view component for scrollable content.
 *   5. Render the status spinner for bottom-line status.
 *   6. Conditionally render the approval menu if approval is pending.
 *   7. Conditionally render the prompt overlay if prompt is pending.
 *   8. Conditionally render the input box and autocomplete if no modal is active.
 *   9. Render autocomplete suggestions if they are available.
 *   10. Render the Ctrl+C warning if exiting requires confirmation.
 *
 * Returns:
 * @returns {JSX.Element} — The main application content with all UI elements.
 *
 * Dependencies:
 *   - useAppContext — provides access to application state and functions.
 *   - Static — Ink component for fixed-position content (banner/history).
 *   - Box — Ink layout component.
 *   - HistoryView — renders scrollable history content.
 *   - StatusSpinner — renders bottom-line status indicator.
 *   - ApprovalMenu — renders command approval prompts.
 *   - PromptOverlay — renders file/skill input overlays.
 *   - InputBox — renders user input field.
 *   - getCommandLabel — provides user-friendly command labels.
 *   - getCommandDescription — provides command descriptions.
 *
 * Dependants:
 *   - App — renders this as the child of AppProvider.
 * </Summary>
 */
const AppContent: React.FC = () => {
  // ===== STEP 1: Extract context values =====
  // Step 1a: Extract all state values and setters from the app context
  const {
    staticEntries,
    spinner,
    approval,
    promptReq,
    showAutocomplete,
    visibleSuggestions,
    activeIndex,
    scrollOffset,
    busy,
    sigintBusy,
  } = useAppContext();

  // ===== STEP 2: Render main layout =====
  // Step 2a: Render main layout box with column direction and full height
  return (
    <Box flexDirection="column" height="100%">
      {/* ===== STEP 3: Render static entries ===== */}
      {/* Step 3a: Render Static component for fixed-position content (banner + history) */}
      <Static items={staticEntries}>
        {/* Step 3b: Render each entry based on its kind */}
        {(staticEntry) =>
          staticEntry.kind === "banner" ? (
            // Step 3b-1: Render banner entries as simple text
            <Text key={staticEntry.key}>{staticEntry.line}</Text>
          ) : (
            // Step 3b-2: Render history entries with proper history rendering
            <Box key={staticEntry.key} flexDirection="column">
              {renderHistoryItem(staticEntry.item, staticEntry.key)}
            </Box>
          )
        }
      </Static>

      {/* ===== STEP 4: Render history view ===== */}
      {/* Step 4a: Render scrollable history view for dynamic content */}
      <HistoryView />

      {/* ===== STEP 5: Render status spinner ===== */}
      {/* Step 5a: Render bottom-line status spinner with current state */}
      <StatusSpinner state={spinner} />

      {/* ===== STEP 6: Render approval menu ===== */}
      {/* Step 6a: Conditionally render approval menu if approval request is pending */}
      {approval && <ApprovalMenu />}

      {/* ===== STEP 7: Render prompt overlay ===== */}
      {/* Step 7a: Conditionally render prompt overlay if prompt request is pending */}
      {promptReq && <PromptOverlay />}

      {/* ===== STEP 8: Render input and autocomplete ===== */}
      {/* Step 8a: Conditionally render input box and autocomplete if no modal is active */}
      {!approval && !promptReq && (
        <Box flexDirection="column">
          {/* ===== STEP 8a-1: Render autocomplete ===== */}
          {/* Step 8a-1a: Conditionally render autocomplete suggestions if available */}
          {showAutocomplete && (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              {/* Step 8a-1b: Render each visible suggestion */}
              {visibleSuggestions.map((suggestionEntry, suggestionIndex) => {
                // Step 8a-1c: Calculate global index for selection tracking
                const globalSuggestionIndex = scrollOffset + suggestionIndex;

                // Step 8a-1d: Check if this suggestion is currently selected
                const isSelected = globalSuggestionIndex === activeIndex;

                // Step 8a-1e: Get user-friendly command label
                const commandLabel = getCommandLabel(suggestionEntry.command);

                // Step 8a-1f: Get command description for help text
                const commandDescription = getCommandDescription(
                  suggestionEntry.command,
                );

                // Step 8a-1g: Render suggestion with selection indicator and styling
                return (
                  <Box key={suggestionEntry.command}>
                    {/* Step 8a-1g-1: Render selection indicator (arrow if selected, spaces otherwise) */}
                    <Text dimColor={!isSelected}>
                      {isSelected ? "▸ " : "  "}
                    </Text>

                    {/* Step 8a-1g-2: Render command label with green color and bold if selected */}
                    <Text color="green" bold={isSelected}>
                      {commandLabel}
                    </Text>

                    {/* Step 8a-1g-3: Render command description with dim styling */}
                    <Text dimColor>
                      {"  "}
                      {commandDescription}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          )}

          {/* ===== STEP 8a-2: Render input box ===== */}
          {/* Step 8a-2a: Render the main user input box */}
          <InputBox />
        </Box>
      )}

      {/* ===== STEP 9: Render exit warning ===== */}
      {/* Step 9a: Conditionally render Ctrl+C warning if user pressed Ctrl+C once while busy */}
      {busy && sigintBusy === 1 && (
        <Text dimColor>Press Ctrl+C again to exit</Text>
      )}
    </Box>
  );
};
