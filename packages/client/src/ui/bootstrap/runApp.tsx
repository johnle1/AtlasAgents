/**
 * Mounts the Ink application and manages the terminal lifecycle.
 *
 * @remarks
 * Renders {@link BootstrapApp}, which runs first-run setup (when needed),
 * connects to the AtlasAgents server, and hands off to the main {@link App}
 * shell. On exit, input history is persisted via {@link saveHistory} and
 * the Node process terminates with code `0` (or `1` if Ink fails to shut
 * down cleanly).
 */
import { render } from "ink";
import { BootstrapApp, type BootstrapAppProps } from "./BootstrapApp.js";
import { saveHistory } from "./historyPersist.js";

/**
 * Options passed to {@link runInkApp} at CLI startup.
 *
 * @remarks
 * A subset of {@link BootstrapAppProps} — the caller supplies CLI overrides
 * and whether first-run setup is required; history persistence is wired
 * internally.
 */
export type RunInkAppOptions = Pick<
  BootstrapAppProps,
  "cliOverrides" | "needsSetup"
>;

/**
 * Renders the Ink UI and blocks until the user exits the application.
 *
 * @remarks
 * This is the single entry point for the terminal UI. It does not return
 * until Ink unmounts; the process then exits. Fatal errors during shutdown
 * are logged to stderr and exit with code `1`.
 *
 * @param options - CLI overrides and first-run setup flag from parsed argv.
 *
 * @example
 * ```ts
 * runInkApp({
 *   cliOverrides: { server: "localhost", port: 7000 },
 *   needsSetup: false,
 * });
 * ```
 */
export const runInkApp = (options: RunInkAppOptions): void => {
  const { waitUntilExit } = render(
    <BootstrapApp {...options} onSaveHistory={saveHistory} />,
  );
  void waitUntilExit()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal: Failed to run Ink application:", err);
      process.exit(1);
    });
};
