/**
 * Sandbox mode slash command: `/sandbox`.
 *
 * @remarks
 * `/sandbox` (or `/sandbox status`) reports the currently configured mode
 * and the backend it actually resolves to on this machine — the two can
 * differ (e.g. `mode: "auto"` with no backend installed). `/sandbox
 * auto|container|off` persists the mode and resets the resolution cache so
 * the change takes effect on the very next command, not after a restart.
 */

import { loadConfig, updateConfig } from "../config/index.js";
import {
  resetSandboxCache,
  resolveConfiguredSandbox,
  type SandboxMode,
} from "../fileProxy/sandbox/index.js";
import { printError, printLine, printSuccessOp } from "../renderer.js";

const VALID_MODES: readonly SandboxMode[] = ["auto", "container", "off"];

const isSandboxModeToken = (value: string): value is SandboxMode =>
  (VALID_MODES as readonly string[]).includes(value);

/** One line describing the mode's effect, shown after `/sandbox <mode>` and in status. */
const modeDescription = (mode: SandboxMode): string => {
  switch (mode) {
    case "auto":
      return "picks the strongest backend available on this machine";
    case "container":
      return "always runs commands in a container, even where a native backend exists";
    case "off":
      return "disabled — commands run unconfined, same as approval prompts alone";
  }
};

/**
 * Prints the configured mode plus the backend it actually resolves to.
 *
 * @remarks
 * These can diverge — `"auto"` with no backend installed still reports
 * "no backend available" so the gap is visible rather than silently unsafe.
 */
const printStatus = (): void => {
  const { sandbox } = loadConfig();
  const resolved = resolveConfiguredSandbox(
    sandbox.mode,
    sandbox.containerImage,
  );

  printLine(`  Sandbox mode: ${sandbox.mode} (${modeDescription(sandbox.mode)})`);
  if (sandbox.mode !== "off") {
    printLine(
      resolved
        ? `  Active backend: ${resolved.id}`
        : "  Active backend: none available — commands run unconfined; install bubblewrap (Linux), or Docker/Podman for a container backend",
    );
  }
  if (sandbox.mode === "container" || resolved?.id.startsWith("container-")) {
    printLine(`  Container image: ${sandbox.containerImage}`);
  }
  printLine("  Change with: /sandbox auto | /sandbox container | /sandbox off");
};

/**
 * Handles `/sandbox [status|auto|container|off]`.
 *
 * @param sub - First token after `/sandbox`.
 *
 * @example
 * ```ts
 * handleSandbox("");          // prints status
 * handleSandbox("container"); // switches to the container backend
 * ```
 */
export const handleSandbox = (sub: string): void => {
  const token = sub.trim().toLowerCase();

  if (token === "" || token === "status") {
    printStatus();
    return;
  }

  if (!isSandboxModeToken(token)) {
    printError(
      `Usage: /sandbox [status|auto|container|off]. Got: "${sub}".`,
    );
    return;
  }

  const { sandbox } = loadConfig();
  updateConfig({ sandbox: { ...sandbox, mode: token } });
  resetSandboxCache();
  printSuccessOp(`Sandbox mode set to ${token} (${modeDescription(token)}).`);
};
