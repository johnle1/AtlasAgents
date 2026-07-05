/**
 * Bootstrap entry points for the Ink terminal UI.
 *
 * @remarks
 * Re-exports the functions and components that wire up first-run setup,
 * server connection, and transition into the main {@link App} shell.
 * Import from this barrel when starting the CLI UI or testing bootstrap
 * behavior in isolation.
 *
 * @example
 * ```ts
 * import { runInkApp } from "./ui/bootstrap/index.js";
 *
 * runInkApp({ cliOverrides: {}, needsSetup: false });
 * ```
 */
export { runInkApp, type RunInkAppOptions } from "./runApp.js";
export { BootstrapApp, type BootstrapAppProps } from "./BootstrapApp.js";
export { SetupWizard } from "./SetupWizard.js";
export { loadHistory, saveHistory } from "./historyPersist.js";
