/**
 * Ink bootstrap — first-run setup, server connection, then main App.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { setInkActive } from "../uiBridge.js";

export type BootstrapAppProps = {
  cliOverrides: CliOverrides;
  needsSetup: boolean;
  onSaveHistory: (lines: string[]) => void;
};

type Phase = "setup" | "connecting" | "ready" | "error";

type ReadyState = {
  connection: Connection;
  commandHandler: CommandHandler;
  fileProxy: LocalFileProxy;
  sessionMessages: string[];
};

export const BootstrapApp: React.FC<BootstrapAppProps> = ({
  cliOverrides,
  needsSetup,
  onSaveHistory,
}) => {
  const { exit } = useApp();
  const exitRef = useRef<(() => void) | undefined>();
  const inputHistoryRef = useRef(loadHistory());
  const [phase, setPhase] = useState<Phase>(needsSetup ? "setup" : "connecting");
  const [config, setConfig] = useState<Config | null>(() =>
    needsSetup ? null : applyCliOverrides(loadConfig(), cliOverrides),
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [readyState, setReadyState] = useState<ReadyState | null>(null);

  useLayoutEffect(() => {
    setInkActive(true);
    return () => setInkActive(false);
  }, []);

  const workspaceRoot = useMemo(() => {
    if (!config) return process.cwd();
    return config.workspace.trim().length > 0 ? config.workspace : process.cwd();
  }, [config]);

  const services = useMemo(() => {
    if (!config) return null;
    const connection = new Connection(config);
    const fileProxy = new LocalFileProxy(workspaceRoot, () => {
      void buildPromptLabel(fileProxy.getCwd());
    });
    connection.setFileProxy(fileProxy);
    return { connection, fileProxy };
  }, [config, workspaceRoot]);

  useEffect(() => {
    if (phase !== "connecting" || !config || !services) return;

    let cancelled = false;
    const { connection, fileProxy } = services;
    const sessionMessages: string[] = [];

    const refreshPrompt = (): void => {
      void buildPromptLabel(fileProxy.getCwd());
    };

    void (async () => {
      try {
        await connection.connect();
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(
            `Could not connect to ${config.server}:${config.port}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          setPhase("error");
        }
        return;
      }

      const skillManager = new SkillManager(connection);
      try {
        const synced = await skillManager.autoSync();
        if (synced > 0) {
          sessionMessages.push(`Synced ${synced} skill(s) to server.`);
        }
      } catch (err) {
        sessionMessages.push(
          `Skill sync failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const sessionExists = await connection.sendCommand<boolean>(
          "session.exists",
          {},
        );
        if (sessionExists) {
          sessionMessages.push(
            "Previous session detected — type /new to clear before starting fresh.",
          );
        }
      } catch {
        // advisory only
      }

      if (cancelled) return;

      const prompts = createInkPromptPort();
      const commandHandler = new CommandHandler(
        connection,
        prompts,
        skillManager,
        fileProxy,
        refreshPrompt,
        () => exitRef.current?.(),
      );

      setReadyState({
        connection,
        commandHandler,
        fileProxy,
        sessionMessages,
      });
      setPhase("ready");
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, config, services]);

  useEffect(
    () => () => {
      onSaveHistory(inputHistoryRef.current);
    },
    [onSaveHistory],
  );

  useInput(() => {
    if (phase === "error") {
      onSaveHistory(inputHistoryRef.current);
      exit();
    }
  });

  if (phase === "setup") {
    return (
      <SetupWizard
        onComplete={(saved) => {
          setConfig(applyCliOverrides(saved, cliOverrides));
          setPhase("connecting");
        }}
      />
    );
  }

  if (phase === "error" && errorMessage) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="red">error: {errorMessage}</Text>
        <Text dimColor>Press any key to exit</Text>
      </Box>
    );
  }

  if (phase === "connecting" && config) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text>
          Connecting to {config.server}:{config.port}…
        </Text>
      </Box>
    );
  }

  if (phase === "ready" && readyState) {
    return (
      <App
        connection={readyState.connection}
        commandHandler={readyState.commandHandler}
        fileProxy={readyState.fileProxy}
        initialHistoryLines={readyState.sessionMessages}
        onSaveHistory={onSaveHistory}
        initialInputHistory={inputHistoryRef.current}
        registerExit={(fn) => {
          exitRef.current = fn;
        }}
        onInputHistoryRef={inputHistoryRef}
      />
    );
  }

  return null;
};
