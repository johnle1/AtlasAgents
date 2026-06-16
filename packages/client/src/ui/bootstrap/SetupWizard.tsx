import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { getDefaultConfig, saveConfig, type Config } from "../../config.js";

/**
 * <Summary>
 * What it does:
 *   Defines the props interface for the SetupWizard component.
 *
 * Used by:
 *   - SetupWizard — receives callback to invoke when setup completes.
 *
 * Produced by:
 *   - App component — creates SetupWizard and provides completion handler.
 * </Summary>
 */
type Props = {
  /** Callback function invoked when setup wizard completes with final configuration. */
  onComplete: (config: Config) => void;
};

/**
 * <Summary>
 * What it does:
 *   Represents the three sequential steps of the setup wizard flow.
 *
 * Used by:
 *   - SetupWizard — tracks current step and renders appropriate input fields.
 *
 * Produced by:
 *   - SetupWizard internal state — advances user through setup stages.
 * </Summary>
 */
type Step = "server" | "port" | "password";

/**
 * <Summary>
 * What it does:
 *   Provides an interactive first-time setup wizard for configuring LoopyCode
 *   server connection settings.
 *
 * How it fits in the system:
 *   Sits between the App component and configuration storage. Guides users
 *   through three sequential steps (server address, port, password) to create
 *   initial configuration when no config file exists.
 *
 * Dependencies:
 *   - React/ink — for terminal UI rendering and state management.
 *   - getDefaultConfig — retrieves default configuration values.
 *   - saveConfig — persists completed configuration to disk.
 *
 * Dependants:
 *   - App component — renders SetupWizard when no existing config is found.
 * </Summary>
 */
export const SetupWizard: React.FC<Props> = ({ onComplete }) => {
  // ===== STATE MANAGEMENT =====
  // Track current wizard step to render appropriate input field
  const [step, setStep] = useState<Step>("server");

  // Store user input for server address (defaults to empty string)
  const [serverAddress, setServerAddress] = useState("");

  // Store user input for port number (defaults to empty string)
  const [portInput, setPortInput] = useState("");

  // Store user input for password (defaults to empty string)
  const [password, setPassword] = useState("");

  // Store port validation error message (null means no error)
  const [portError, setPortError] = useState<string | null>(null);

  /**
   * <Summary>
   * What it does:
   *   Validates and saves the completed configuration, then triggers the
   *   completion callback.
   *
   * How it does it (step by step):
   *   1. Retrieve default configuration values as base template.
   *   2. Determine final server address (user input or "localhost" default).
   *   3. Parse and validate port number from user input (default to 7000).
   *   4. Merge user-provided values with defaults into final config object.
   *   5. Persist configuration to disk using saveConfig.
   *   6. Invoke completion callback to signal setup is finished.
   *
   * Parameters:
   *   @param {string} passwordValue — The password string entered by user.
   *
   * Returns:
   *   void — called for side effects (config save and callback invocation).
   *
   * Dependencies:
   *   - getDefaultConfig — retrieves base configuration defaults.
   *   - saveConfig — persists final configuration to disk.
   *
   * Dependants:
   *   - SetupWizard password input onSubmit — triggers when user submits password.
   * </Summary>
   */
  const finish = (passwordValue: string): void => {
    // ===== STEP 1: Retrieve Default Configuration =====
    // Get base configuration values to use as template
    const defaults = getDefaultConfig();

    // ===== STEP 2: Determine Server Address =====
    // Use user input if provided, otherwise default to "localhost"
    const trimmedServerAddress = serverAddress.trim();
    const finalServerAddress =
      trimmedServerAddress.length > 0 ? trimmedServerAddress : "localhost";

    // ===== STEP 3: Parse and Validate Port Number =====
    // Start with default port 7000
    let finalServerPort = 7000;

    // Trim user input and parse if not empty
    const trimmedPortInput = portInput.trim();
    if (trimmedPortInput.length > 0) {
      const parsedPort = parseInt(trimmedPortInput, 10);

      // Validate port is within valid range (1-65535)
      if (
        !Number.isNaN(parsedPort) &&
        parsedPort >= 1 &&
        parsedPort <= 65_535
      ) {
        finalServerPort = parsedPort;
      }
      // If parsing fails or out of range, keep default 7000
    }

    // ===== STEP 4: Build Final Configuration Object =====
    // Merge user values with defaults using spread operator
    const config: Config = {
      ...defaults,
      server: finalServerAddress,
      port: finalServerPort,
      password: passwordValue,
    };

    // ===== STEP 5: Persist Configuration =====
    // Save completed configuration to disk
    saveConfig(config);

    // ===== STEP 6: Signal Completion =====
    // Invoke callback to notify parent component setup is complete
    onComplete(config);
  };

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold>Welcome to LoopyCode</Text>
      <Text dimColor>First-time setup — connect to your LoopyCode server.</Text>
      <Box marginTop={1} flexDirection="column">
        {/* ===== STEP 1: SERVER ADDRESS INPUT ===== */}
        {step === "server" && (
          <>
            <Text>Enter server address (default localhost):</Text>
            <TextInput
              value={serverAddress}
              onChange={setServerAddress}
              onSubmit={() => setStep("port")}
            />
          </>
        )}

        {/* ===== STEP 2: PORT NUMBER INPUT ===== */}
        {step === "port" && (
          <>
            <Text>Enter port (default 7000):</Text>
            {/* Display validation error message if present */}
            {portError && <Text color="red">{portError}</Text>}
            <TextInput
              value={portInput}
              onChange={(inputValue) => {
                // Clear any existing error when user starts typing
                setPortInput(inputValue);
                setPortError(null);
              }}
              onSubmit={(inputValue) => {
                // ===== PORT VALIDATION LOGIC =====
                // Trim whitespace from input
                const trimmedInput = inputValue.trim();

                // If empty, accept default and advance to password step
                if (trimmedInput.length === 0) {
                  setStep("password");
                  return;
                }

                // Parse input as integer
                const parsedPort = parseInt(trimmedInput, 10);

                // Validate port is within valid range (1-65535)
                if (
                  Number.isNaN(parsedPort) ||
                  parsedPort < 1 ||
                  parsedPort > 65_535
                ) {
                  // Invalid: show error and stay on port step
                  setPortError("Port must be an integer between 1 and 65535.");
                  return;
                }

                // Valid: advance to password step
                setStep("password");
              }}
            />
          </>
        )}

        {/* ===== STEP 3: PASSWORD INPUT ===== */}
        {step === "password" && (
          <>
            <Text>Enter password:</Text>
            <TextInput
              value={password}
              onChange={setPassword}
              mask="*" // Hide password input with asterisks
              onSubmit={(passwordValue) => finish(passwordValue)}
            />
          </>
        )}
      </Box>
    </Box>
  );
};
