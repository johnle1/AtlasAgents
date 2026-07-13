/**
 * Startup shell for the Ink CLI: setup wizard, server connection, and handoff to {@link App}.
 *
 * @remarks
 * {@link BootstrapApp} is the root React component rendered by {@link runInkApp}.
 * It progresses through four phases — setup, connecting, ready, and error — and
 * only mounts the main application once an RSocket connection and supporting
 * services (command handler, file proxy, skills) are initialized.
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
import { CommandHandler } from "../../commands/index.js";
import { SkillManager } from "../../skills.js";
import { buildPromptLabel } from "../../pathDisplay.js";
import { LocalFileProxy } from "../../localFileProxy.js";
import { createInkPromptPort } from "../promptPort.js";
import { App } from "../App.js";
import { SetupWizard } from "./SetupWizard.js";
import { loadHistory } from "./historyPersist.js";
import { wireSessionAbortSignal } from "./wireSessionAbortSignal.js";
import { setInkActive } from "../uiBridge.js";
import {
  printTokenSaveInitTip,
  syncTokenSaveTools,
} from "../../commands/tokenSaveHandlers.js";

/**
 * Props for {@link BootstrapApp}.
 */
export type BootstrapAppProps = {
  /**
   * CLI flag overrides applied on top of the on-disk config.
   *
   * @remarks
   * Applied after the setup wizard saves config and again when loading
   * an existing config so `--server` / `--port` win over saved values.
   */
  cliOverrides: CliOverrides;

  /** When `true`, render {@link SetupWizard} before attempting connection. */
  needsSetup: boolean;

  /**
   * Persists arrow-key input history on exit.
   *
   * @remarks
   * Called on unmount and when the user dismisses a connection error screen.
   */
  onSaveHistory: (lines: string[]) => void;
};

/**
 * Discrete phases of the bootstrap state machine.
 *
 * @remarks
 * Transitions: `setup` → `connecting` → `ready`, or `connecting` → `error`
 * when the server is unreachable. There is no recovery from `error` except
 * restarting the CLI.
 */
type BootstrapPhase = "setup" | "connecting" | "ready" | "error";

/**
 * Services and session hints available once bootstrap reaches the `ready` phase.
 */
type ReadyAppState = {
  /** Live RSocket connection to the LoopyCode server. */
  connection: Connection;
  /** Slash-command and prompt handler wired to the connection. */
  commandHandler: CommandHandler;
  /** Client-side file proxy the server invokes for workspace I/O. */
  fileProxy: LocalFileProxy;
  /**
   * One-shot messages shown in history on startup (skill sync, prior session).
   *
   * @remarks
   * Populated during connection; not persisted across restarts.
   */
  sessionMessages: string[];
};

/**
 * Root bootstrap component: setup, connect, then render {@link App}.
 *
 * @remarks
 * Activates Ink rendering mode, loads config and input history, establishes
 * the server connection, syncs skills, and passes initialized services to
 * {@link App}. Connection and skill-sync failures are handled at different
 * severity levels — a failed connect blocks startup; skill sync failures
 * are logged as session messages and startup continues.
 *
 * @example
 * ```tsx
 * <BootstrapApp
 *   cliOverrides={{}}
 *   needsSetup={false}
 *   onSaveHistory={saveHistory}
 * />
 * ```
 */
export const BootstrapApp: React.FC<BootstrapAppProps> = ({
  cliOverrides,
  needsSetup,
  onSaveHistory,
}) => {
  const { exit } = useApp();

  // Registered by App so slash /exit and Ctrl+C share the same teardown path.
  // Using a ref avoids re-rendering BootstrapApp when App mounts its exit handler.
  const exitHandlerRef = useRef<(() => void) | undefined>();

  const inputHistoryRef = useRef(loadHistory());

  const [bootstrapPhase, setBootstrapPhase] = useState<BootstrapPhase>(
    needsSetup ? "setup" : "connecting",
  );

  // Config is null during first-run setup until the wizard calls onComplete.
  // Lazy-initialize with existing config when needsSetup is false to avoid
  // unnecessary config reads on every render.
  const [appConfig, setAppConfig] = useState<Config | null>(() =>
    needsSetup ? null : applyCliOverrides(loadConfig(), cliOverrides),
  );

  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [readyAppState, setReadyAppState] = useState<ReadyAppState | null>(
    null,
  );

  // uiBridge routes log output away from Ink while the terminal UI is active.
  // useLayoutEffect ensures this happens synchronously before paint to prevent
  // log flicker during the initial render.
  useLayoutEffect(() => {
    setInkActive(true);
    return () => setInkActive(false);
  }, []);

  const workspaceRootDirectory = useMemo(() => {
    if (!appConfig) return process.cwd();
    // Fall back to process.cwd() if the config has an empty workspace string.
    // This can happen when users clear the workspace field in the setup wizard.
    return appConfig.workspace.trim().length > 0
      ? appConfig.workspace
      : process.cwd();
  }, [appConfig]);

  const connectionServices = useMemo(() => {
    if (!appConfig) return null;

    const rsocketConnection = new Connection(appConfig);

    const localFileProxy = new LocalFileProxy(workspaceRootDirectory, () => {
      void buildPromptLabel(localFileProxy.getCwd());
    });

    // Wire the file proxy into the connection so the server can invoke it
    // for workspace I/O, and wire the session abort signal so shell commands
    // terminate when the connection drops.
    rsocketConnection.setFileProxy(localFileProxy);
    wireSessionAbortSignal(rsocketConnection, localFileProxy);

    return { connection: rsocketConnection, fileProxy: localFileProxy };
  }, [appConfig, workspaceRootDirectory]);

  useEffect(() => {
    if (bootstrapPhase !== "connecting" || !appConfig || !connectionServices) {
      return;
    }

    // Flag to prevent state updates if the component unmounts during async work.
    // This is critical because the connection effect can run for several seconds
    // while the user might dismiss the error screen and trigger unmount.
    let connectionCancelled = false;

    const { connection: rsocketConnection, fileProxy: localFileProxy } =
      connectionServices;

    const sessionInitializationMessages: string[] = [];

    const refreshPromptLabel = (): void => {
      void buildPromptLabel(localFileProxy.getCwd());
    };

    void (async () => {
      try {
        await rsocketConnection.connect();
      } catch (connectionError) {
        if (!connectionCancelled) {
          setConnectionError(
            `Could not connect to ${appConfig.server}:${appConfig.port}: ${
              connectionError instanceof Error
                ? connectionError.message
                : String(connectionError)
            }`,
          );
          setBootstrapPhase("error");
        }
        return;
      }

      const skillManager = new SkillManager(rsocketConnection);

      // Skill sync is best-effort — a failure should not block the main UI.
      // Users can still interact with the server even if skills fail to sync,
      // and they can retry manually with /skills sync.
      try {
        const syncedSkillCount = await skillManager.autoSync();
        if (syncedSkillCount > 0) {
          sessionInitializationMessages.push(
            `Synced ${syncedSkillCount} skill(s) to server.`,
          );
        }
      } catch (skillSyncError) {
        sessionInitializationMessages.push(
          `Skill sync failed: ${
            skillSyncError instanceof Error
              ? skillSyncError.message
              : String(skillSyncError)
          }`,
        );
      }

      try {
        const syncedToolCount = await syncTokenSaveTools(
          rsocketConnection,
          workspaceRootDirectory,
        );
        if (syncedToolCount > 0) {
          sessionInitializationMessages.push(
            `Synced ${syncedToolCount} TokenSave tool(s) to server.`,
          );
        } else {
          await printTokenSaveInitTip(workspaceRootDirectory);
        }
      } catch (tokenSaveSyncError) {
        sessionInitializationMessages.push(
          `TokenSave sync failed: ${
            tokenSaveSyncError instanceof Error
              ? tokenSaveSyncError.message
              : String(tokenSaveSyncError)
          }`,
        );
      }

      // Inform the user if a server session already exists; ignore RPC errors.
      // This is advisory only — startup continues without the hint if the RPC fails.
      // The hint helps users avoid confusing state where two clients share one session.
      try {
        const sessionExists = await rsocketConnection.sendCommand<boolean>(
          "session.exists",
          {},
        );
        if (sessionExists) {
          sessionInitializationMessages.push(
            "Previous session detected — type /new to clear before starting fresh.",
          );
        }
      } catch {
        // Advisory only — startup continues without the hint
      }

      if (connectionCancelled) return;

      const promptInterface = createInkPromptPort();

      const commandHandler = new CommandHandler({
        conn: rsocketConnection,
        prompts: promptInterface,
        skills: skillManager,
        fileProxy: localFileProxy,
        onPromptUpdate: refreshPromptLabel,
        onExit: () => exitHandlerRef.current?.(),
      });

      setReadyAppState({
        connection: rsocketConnection,
        commandHandler,
        fileProxy: localFileProxy,
        sessionMessages: sessionInitializationMessages,
      });

      setBootstrapPhase("ready");
    })();

    return () => {
      // Set the flag to prevent state updates if the effect cleanup runs
      // after async operations complete but before the component fully unmounts.
      connectionCancelled = true;
    };
  }, [bootstrapPhase, appConfig, connectionServices]);

  // Persist input history on unmount so arrow-key navigation survives restarts.
  // This runs on both normal exit and error-screen dismissal.
  useEffect(
    () => () => {
      onSaveHistory(inputHistoryRef.current);
    },
    [onSaveHistory],
  );

  // Allow the user to dismiss the error screen with any key press.
  // This is the only recovery path from a connection failure — the CLI
  // exits cleanly rather than hanging.
  useInput(() => {
    if (bootstrapPhase === "error") {
      onSaveHistory(inputHistoryRef.current);
      exit();
    }
  });

  if (bootstrapPhase === "setup") {
    return (
      <SetupWizard
        onComplete={(savedConfig) => {
          setAppConfig(applyCliOverrides(savedConfig, cliOverrides));
          setBootstrapPhase("connecting");
        }}
      />
    );
  }

  if (bootstrapPhase === "error" && connectionError) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="red">error: {connectionError}</Text>
        <Text dimColor>Press any key to exit</Text>
      </Box>
    );
  }

  if (bootstrapPhase === "connecting" && appConfig) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text>
          Connecting to {appConfig.server}:{appConfig.port}…
        </Text>
      </Box>
    );
  }

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

  return null;
};
