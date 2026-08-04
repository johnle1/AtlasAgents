/**
 * First-run setup wizard for LoopyCode server connection settings.
 *
 * @remarks
 * Shown when no config file exists ({@link BootstrapApp} with
 * `needsSetup: true`). Collects server address, port, and password in
 * three sequential steps, persists the result with {@link saveConfig}, and
 * notifies the parent via `onComplete` so connection can begin.
 */
import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { loadConfig, saveConfig, type Config } from "../../config/index.js";

/**
 * Callback props for {@link SetupWizard}.
 */
type Props = {
  /**
   * Called after the wizard saves config to disk.
   *
   * @param config - The merged configuration written by {@link saveConfig}.
   */
  onComplete: (config: Config) => void;
};

/** Wizard steps in display order. */
type Step = "server" | "port" | "password";

/**
 * Interactive three-step form for initial server connection settings.
 *
 * @remarks
 * Empty server defaults to `localhost`; empty port defaults to `7000`.
 * Invalid port input on the port step shows an inline error and keeps
 * the user on that step. Password may be left empty for unsecured servers.
 *
 * @example
 * ```tsx
 * <SetupWizard
 *   onComplete={(config) => {
 *     setAppConfig(config);
 *     setBootstrapPhase("connecting");
 *   }}
 * />
 * ```
 */
export const SetupWizard: React.FC<Props> = ({ onComplete }) => {
  const [step, setStep] = useState<Step>("server");
  const [serverAddress, setServerAddress] = useState("");
  const [portInput, setPortInput] = useState("");
  const [password, setPassword] = useState("");
  const [portError, setPortError] = useState<string | null>(null);

  /**
   * Merges wizard input with the existing config, persists it, and notifies parent.
   *
   * @remarks
   * Builds on {@link loadConfig} rather than the defaults so the wizard only
   * ever writes `server`, `port`, and `password`. The wizard is no longer
   * reached solely on a truly fresh install — `loopy --reset` clears the
   * connection settings and lands here too — so starting from defaults would
   * silently discard the user's theme, model choices, and workspace.
   *
   * Port validation here mirrors the port step but is lenient: invalid
   * numeric input falls back to `7000` rather than blocking completion,
   * because the user already passed the strict port-step gate.
   */
  const finish = (passwordValue: string): void => {
    const existingConfig = loadConfig();

    const trimmedServerAddress = serverAddress.trim();
    const finalServerAddress =
      trimmedServerAddress.length > 0 ? trimmedServerAddress : "localhost";

    let finalServerPort = 7000;

    const trimmedPortInput = portInput.trim();
    if (trimmedPortInput.length > 0) {
      const parsedPort = parseInt(trimmedPortInput, 10);
      if (
        !Number.isNaN(parsedPort) &&
        parsedPort >= 1 &&
        parsedPort <= 65_535
      ) {
        finalServerPort = parsedPort;
      }
    }

    const config: Config = {
      ...existingConfig,
      server: finalServerAddress,
      port: finalServerPort,
      password: passwordValue,
    };

    saveConfig(config);
    onComplete(config);
  };

  const stepOrder: Step[] = ["server", "port", "password"];
  const currentIndex = stepOrder.indexOf(step);
  const resolvedServerAddress = serverAddress.trim() || "localhost";
  const resolvedPort = portInput.trim() || "7000";

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold>Welcome to LoopyCode</Text>
      <Text dimColor>First-time setup — connect to your LoopyCode server.</Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text>Server address: </Text>
          {step === "server" ? (
            <TextInput
              value={serverAddress}
              onChange={setServerAddress}
              placeholder="localhost"
              onSubmit={() => setStep("port")}
            />
          ) : (
            <Text>{resolvedServerAddress}</Text>
          )}
        </Box>

        {currentIndex >= 1 && (
          <Box flexDirection="column">
            <Box>
              <Text>Port: </Text>
              {step === "port" ? (
                <TextInput
                  value={portInput}
                  onChange={(inputValue) => {
                    setPortInput(inputValue);
                    setPortError(null);
                  }}
                  placeholder="7000"
                  onSubmit={(inputValue) => {
                    const trimmedInput = inputValue.trim();

                    // Empty input accepts the default port and advances
                    if (trimmedInput.length === 0) {
                      setStep("password");
                      return;
                    }

                    const parsedPort = parseInt(trimmedInput, 10);

                    if (
                      Number.isNaN(parsedPort) ||
                      parsedPort < 1 ||
                      parsedPort > 65_535
                    ) {
                      setPortError(
                        "Port must be an integer between 1 and 65535.",
                      );
                      return;
                    }

                    setStep("password");
                  }}
                />
              ) : (
                <Text>{resolvedPort}</Text>
              )}
            </Box>
            {step === "port" && portError && (
              <Text color="red">{portError}</Text>
            )}
          </Box>
        )}

        {currentIndex >= 2 && (
          <Box>
            <Text>Password: </Text>
            <TextInput
              value={password}
              onChange={setPassword}
              mask="*"
              onSubmit={(passwordValue) => finish(passwordValue)}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
};
