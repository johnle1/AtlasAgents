/**
 * <Summary>
 * What it does:
 *   Bootstrap component that manages the initial application startup sequence,
 *   including first-run setup, server connection, and initialization of core services.
 *
 * How it fits in the system:
 *   This component serves as the entry point for the Ink-based CLI UI, handling the
 *   complete bootstrap process from initial setup through server connection to launching
 *   the main application. It manages the connection lifecycle, skill synchronization,
 *   and provides error handling for the startup sequence.
 *
 * Dependencies:
 *   - SetupWizard — handles first-run configuration wizard.
 *   - Connection — establishes RSocket connection to the server.
 *   - CommandHandler — processes CLI commands.
 *   - SkillManager — manages skill synchronization with server.
 *   - LocalFileProxy — provides file system operations.
 *   - App — main application component launched after bootstrap.
 *
 * Dependants:
 *   - BootstrapApp.tsx entry point — renders this component as the initial UI.
 * </Summary>
 */

import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CliOverrides } from "../../cliArgs.js";
import { applyCliOverrides } from "../../cliArgs.js";
import { loadConfig, type Config } from "../../config.js";
import { Connection } from "../../connection/index.js";
import {
  CommandHandler,
  type CommandHandlerDeps,
} from "../../commands/index.js";
import { SkillManager } from "../../skills.js";
import { buildPromptLabel } from "../../pathDisplay.js";
import { LocalFileProxy } from "../../localFileProxy.js";
import { createInkPromptPort } from "../promptPort.js";
import { App } from "../App.js";
import { SetupWizard } from "./SetupWizard.js";
import { loadHistory } from "./historyPersist.js";
import { setInkActive } from "../uiBridge.js";

/**
 * <Summary>
 * What it does:
 *   Defines the properties required by the BootstrapApp component.
 *
 * Used by:
 *   - BootstrapApp — receives these properties from parent component.
 *
 * Produced by:
 *   - Parent component (index.ts or similar) — provides these values.
 * </Summary>
 */
export type BootstrapAppProps = {
  /** CLI argument overrides for configuration values. */
  cliOverrides: CliOverrides;
  /** Flag indicating if first-run setup is needed. */
  needsSetup: boolean;
  /** Callback to save input history before application exit. */
  onSaveHistory: (lines: string[]) => void;
};

/**
 * <Summary>
 * What it does:
 *   Represents the different phases of the bootstrap process.
 *
 * Used by:
 *   - BootstrapApp — tracks current bootstrap phase for rendering appropriate UI.
 *
 * Produced by:
 *   - BootstrapApp — updates phase state during bootstrap process.
 * </Summary>
 */
type BootstrapPhase = "setup" | "connecting" | "ready" | "error";

/**
 * <Summary>
 * What it does:
 *   Defines the state of the application when it's ready to run.
 *
 * Used by:
 *   - BootstrapApp — stores initialized services for passing to App component.
 *
 * Produced by:
 *   - BootstrapApp connection logic — creates this state after successful initialization.
 * </Summary>
 */
type ReadyAppState = {
  /** The established RSocket connection to the server. */
  connection: Connection;
  /** The command handler for processing CLI commands. */
  commandHandler: CommandHandler;
  /** The file proxy for file system operations. */
  fileProxy: LocalFileProxy;
  /** Session messages to display in the initial history. */
  sessionMessages: string[];
};

/**
 * <Summary>
 * What it does:
 *   Main bootstrap component that manages the application startup sequence.
 *
 * How it does it (step by step):
 *   1. Receives CLI overrides and setup requirements from props.
 *   2. Initializes state for tracking bootstrap phase, config, and services.
 *   3. Activates Ink terminal mode for proper rendering.
 *   4. Renders appropriate UI based on current phase (setup, connecting, ready, error).
 *   5. Manages connection establishment and service initialization.
 *   6. Passes initialized services to main App component when ready.
 *
 * Parameters:
 *   @param {BootstrapAppProps} bootstrapProps — Properties for bootstrap process.
 *
 * Returns:
 *   @returns {JSX.Element} — The appropriate UI component based on bootstrap phase.
 *
 * Dependencies:
 *   - React hooks — useState, useEffect, useMemo, useRef, useLayoutEffect.
 *   - Ink components — Box, Text, useApp, useInput.
 *   - Application services — Connection, CommandHandler, SkillManager, etc.
 *
 * Dependants:
 *   - BootstrapApp entry point — renders this component as the initial UI.
 * </Summary>
 */
export const BootstrapApp: React.FC<BootstrapAppProps> = ({
  cliOverrides,
  needsSetup,
  onSaveHistory,
}) => {
  // ===== STEP 1: Get Ink App Exit Function =====
  // Step 1a: Extract the exit function from the Ink useApp hook
  // Step 1b: This allows the application to cleanly exit the terminal UI
  const { exit } = useApp();

  // ===== STEP 2: Initialize Refs for Exit Handler and History =====
  // Step 2a: Create ref to store the exit handler function
  // Step 2b: This allows the App component to register its exit handler
  const exitHandlerRef = useRef<(() => void) | undefined>();

  // Step 2c: Create ref to store input history from previous session
  // Step 2d: Load persisted history from disk on component mount
  const inputHistoryRef = useRef(loadHistory());

  // ===== STEP 3: Initialize Bootstrap Phase State =====
  // Step 3a: Set initial phase based on whether setup is needed
  // Step 3b: If setup needed, start in setup phase; otherwise start connecting
  const [bootstrapPhase, setBootstrapPhase] = useState<BootstrapPhase>(
    needsSetup ? "setup" : "connecting",
  );

  // ===== STEP 4: Initialize Configuration State =====
  // Step 4a: Load configuration on component mount
  // Step 4b: If setup needed, start with null config; otherwise load and apply CLI overrides
  const [appConfig, setAppConfig] = useState<Config | null>(() =>
    needsSetup ? null : applyCliOverrides(loadConfig(), cliOverrides),
  );

  // ===== STEP 5: Initialize Error Message State =====
  // Step 5a: Create state for storing error messages during bootstrap
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // ===== STEP 6: Initialize Ready State =====
  // Step 6a: Create state for storing the initialized application state
  // Step 6b: This holds the connection, command handler, and other services when ready
  const [readyAppState, setReadyAppState] = useState<ReadyAppState | null>(
    null,
  );

  // ===== STEP 7: Activate Ink Terminal Mode =====
  // Step 7a: Use useLayoutEffect to activate Ink mode immediately on mount
  // Step 7b: This ensures proper terminal rendering and input handling
  // Step 7c: Clean up by deactivating Ink mode on unmount
  useLayoutEffect(() => {
    setInkActive(true);
    return () => setInkActive(false);
  }, []);

  // ===== STEP 8: Calculate Workspace Root Directory =====
  // Step 8a: Use useMemo to calculate workspace root from config
  // Step 8b: If no config or empty workspace, default to current working directory
  // Step 8c: This provides the security boundary for file operations
  const workspaceRootDirectory = useMemo(() => {
    if (!appConfig) return process.cwd();
    return appConfig.workspace.trim().length > 0
      ? appConfig.workspace
      : process.cwd();
  }, [appConfig]);

  // ===== STEP 9: Initialize Connection and File Proxy Services =====
  // Step 9a: Use useMemo to create connection and file proxy instances
  // Step 9b: These are recreated when config or workspace changes
  // Step 9c: File proxy is registered with connection for server-initiated file ops
  const connectionServices = useMemo(() => {
    // Step 9a-i: Return null if config not yet available
    if (!appConfig) return null;

    // Step 9a-ii: Create RSocket connection instance
    const rsocketConnection = new Connection(appConfig);

    // Step 9a-iii: Create file proxy instance with workspace root
    // Step 9a-iii-1: Provide callback to refresh prompt when directory changes
    const localFileProxy = new LocalFileProxy(workspaceRootDirectory, () => {
      void buildPromptLabel(localFileProxy.getCwd());
    });

    // Step 9a-iv: Register file proxy with connection
    // Step 9a-iv-1: This allows server to request file operations on the client
    rsocketConnection.setFileProxy(localFileProxy);

    // Step 9a-v: Return both services for use in connection logic
    return { connection: rsocketConnection, fileProxy: localFileProxy };
  }, [appConfig, workspaceRootDirectory]);

  // ===== STEP 10: Manage Connection and Service Initialization =====
  // Step 10a: Use useEffect to handle connection when phase is "connecting"
  // Step 10b: This effect runs when phase changes to "connecting"
  useEffect(() => {
    // Step 10a-i: Only proceed if phase is connecting and config/services are available
    if (bootstrapPhase !== "connecting" || !appConfig || !connectionServices) {
      return;
    }

    // ===== STEP 10a-i-1: Initialize Connection Process =====
    // Step 10a-i-1-a: Flag to track if connection process was cancelled
    let connectionCancelled = false;

    // Step 10a-i-1-b: Extract services from memoized object
    const { connection: rsocketConnection, fileProxy: localFileProxy } =
      connectionServices;

    // Step 10a-i-1-c: Array to store session initialization messages
    const sessionInitializationMessages: string[] = [];

    // ===== STEP 10a-i-1-d: Create Prompt Refresh Function =====
    // Step 10a-i-1-d-1: Function to refresh the prompt when directory changes
    const refreshPromptLabel = (): void => {
      void buildPromptLabel(localFileProxy.getCwd());
    };

    // ===== STEP 10a-i-1-e: Perform Connection Sequence =====
    // Step 10a-i-1-e-1: Use async IIFE to perform connection sequence
    void (async () => {
      // ===== STEP 10a-i-1-e-1-a: Establish RSocket Connection =====
      try {
        // Step 10a-i-1-e-1-a-1: Attempt to connect to the server
        await rsocketConnection.connect();
      } catch (connectionError) {
        // ===== HANDLE CONNECTION FAILURE =====
        // Step 10a-i-1-e-1-a-2: Only handle error if connection wasn't cancelled
        if (!connectionCancelled) {
          // Step 10a-i-1-e-1-a-3: Set error message with server details
          setConnectionError(
            `Could not connect to ${appConfig.server}:${appConfig.port}: ${
              connectionError instanceof Error
                ? connectionError.message
                : String(connectionError)
            }`,
          );
          // Step 10a-i-1-e-1-a-4: Switch to error phase to show error UI
          setBootstrapPhase("error");
        }
        return;
      }

      // ===== STEP 10a-i-1-e-1-b: Initialize Skill Manager =====
      // Step 10a-i-1-e-1-b-1: Create skill manager for skill synchronization
      const skillManager = new SkillManager(rsocketConnection);

      // Step 10a-i-1-e-1-b-2: Attempt to synchronize skills with server
      try {
        const syncedSkillCount = await skillManager.autoSync();
        // Step 10a-i-1-e-1-b-3: Add message if any skills were synced
        if (syncedSkillCount > 0) {
          sessionInitializationMessages.push(
            `Synced ${syncedSkillCount} skill(s) to server.`,
          );
        }
      } catch (skillSyncError) {
        // Step 10a-i-1-e-1-b-4: Log skill sync failure but don't block startup
        sessionInitializationMessages.push(
          `Skill sync failed: ${
            skillSyncError instanceof Error
              ? skillSyncError.message
              : String(skillSyncError)
          }`,
        );
      }

      // ===== STEP 10a-i-1-e-1-c: Check for Existing Session =====
      // Step 10a-i-1-e-1-c-1: Try to check if a previous session exists on server
      try {
        const sessionExists = await rsocketConnection.sendCommand<boolean>(
          "session.exists",
          {},
        );
        // Step 10a-i-1-e-1-c-2: If session exists, add advisory message
        if (sessionExists) {
          sessionInitializationMessages.push(
            "Previous session detected — type /new to clear before starting fresh.",
          );
        }
      } catch {
        // Step 10a-i-1-e-1-c-3: Session check failed silently (advisory only)
        // Step 10a-i-1-e-1-c-4: Don't block startup if this check fails
      }

      // ===== STEP 10a-i-1-e-1-d: Check for Cancellation =====
      // Step 10a-i-1-e-1-d-1: If connection was cancelled, abort initialization
      if (connectionCancelled) return;

      // ===== STEP 10a-i-1-e-1-e: Initialize Command Handler =====
      // Step 10a-i-1-e-1-e-1: Create prompt interface for user interaction
      const promptInterface = createInkPromptPort();

      // Step 10a-i-1-e-1-e-2: Create command handler with all dependencies
      const commandHandler = new CommandHandler({
        conn: rsocketConnection,
        prompts: promptInterface,
        skills: skillManager,
        fileProxy: localFileProxy,
        onPromptUpdate: refreshPromptLabel,
        onExit: () => exitHandlerRef.current?.(),
      });

      // ===== STEP 10a-i-1-e-1-f: Set Ready State =====
      // Step 10a-i-1-e-1-f-1: Store all initialized services in ready state
      setReadyAppState({
        connection: rsocketConnection,
        commandHandler,
        fileProxy: localFileProxy,
        sessionMessages: sessionInitializationMessages,
      });

      // Step 10a-i-1-e-1-f-2: Switch to ready phase to launch main app
      setBootstrapPhase("ready");
    })();

    // ===== STEP 10a-i-2: Cleanup Function =====
    // Step 10a-i-2-a: Return cleanup function to cancel connection on unmount
    return () => {
      connectionCancelled = true;
    };
  }, [bootstrapPhase, appConfig, connectionServices]);

  // ===== STEP 11: Save Input History on Unmount =====
  // Step 11a: Use useEffect to save history when component unmounts
  // Step 11b: This ensures input history persists across application restarts
  useEffect(
    () => () => {
      onSaveHistory(inputHistoryRef.current);
    },
    [onSaveHistory],
  );

  // ===== STEP 12: Handle Exit on Error Phase =====
  // Step 12a: Use useInput to listen for keyboard input
  // Step 12b: If in error phase, save history and exit on any key press
  useInput(() => {
    if (bootstrapPhase === "error") {
      onSaveHistory(inputHistoryRef.current);
      exit();
    }
  });

  // ===== STEP 13: Render Setup Phase UI =====
  // Step 13a: If in setup phase, render the setup wizard
  if (bootstrapPhase === "setup") {
    return (
      <SetupWizard
        onComplete={(savedConfig) => {
          // Step 13a-i: Apply CLI overrides to saved config
          setAppConfig(applyCliOverrides(savedConfig, cliOverrides));
          // Step 13a-ii: Move to connecting phase
          setBootstrapPhase("connecting");
        }}
      />
    );
  }

  // ===== STEP 14: Render Error Phase UI =====
  // Step 14a: If in error phase with error message, render error display
  if (bootstrapPhase === "error" && connectionError) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="red">error: {connectionError}</Text>
        <Text dimColor>Press any key to exit</Text>
      </Box>
    );
  }

  // ===== STEP 15: Render Connecting Phase UI =====
  // Step 15a: If in connecting phase with config, render connection status
  if (bootstrapPhase === "connecting" && appConfig) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text>
          Connecting to {appConfig.server}:{appConfig.port}…
        </Text>
      </Box>
    );
  }

  // ===== STEP 16: Render Ready Phase UI =====
  // Step 16a: If in ready phase with ready state, render main application
  if (bootstrapPhase === "ready" && readyAppState) {
    return (
      <App
        connection={readyAppState.connection}
        commandHandler={readyAppState.commandHandler}
        fileProxy={readyAppState.fileProxy}
        initialHistoryLines={readyAppState.sessionMessages}
        onSaveHistory={onSaveHistory}
        initialInputHistory={inputHistoryRef.current}
        registerExit={(exitHandler) => {
          exitHandlerRef.current = exitHandler;
        }}
        onInputHistoryRef={inputHistoryRef}
      />
    );
  }

  // ===== STEP 17: Render Nothing for Other States =====
  // Step 17a: Return null if in unexpected state (should not happen)
  return null;
};
