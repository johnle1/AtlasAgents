/**
 * Public entry point for the client config module.
 *
 * @remarks
 * The implementation is split across sibling files by responsibility:
 * - `types.ts` — `Config`, `UiConfig`, the internal `StoredConfig`/
 *   `SecretConfigFields` on-disk shapes, `DEFAULT_CONFIG`, and the path/
 *   passphrase constants.
 * - `parsing.ts` — merges raw disk JSON with `DEFAULT_CONFIG` into a
 *   complete `Config`, and decides whether the merge needs to be persisted.
 * - `manager.ts` — `loadConfig`/`saveConfig` disk I/O (including the
 *   password/server encrypt-decrypt calls) and the small get/set/ensureDirs
 *   accessors built on top of them.
 * - `cipher.ts` — the passphrase *lifecycle*: first-run setup, unlocking an
 *   existing encrypted or legacy plaintext file, the forgotten-passphrase
 *   reset menu, and passphrase rotation.
 *
 * Re-exports exactly what `config.ts` exported before this split, so no
 * import path outside this folder needs to change beyond pointing at
 * `config/index.js` instead of `config.js`.
 */

export type { Config, UiConfig, ApprovalModeDisplay } from "./types.js";
export type { ApprovalMode, PersistedApprovalMode } from "./approvalMode.js";
export {
  parseApprovalMode,
  parsePersistedApprovalMode,
  formatApprovalModeLabel,
  approvalModeDisplay,
} from "./approvalMode.js";
export { HISTORY_FILE, SKILLS_DIR, APPROVAL_MODE_DISPLAY } from "./types.js";
export {
  ensureDirs,
  getConfig,
  getDefaultConfig,
  hasConfigFile,
  isConnectionConfigured,
  loadConfig,
  saveConfig,
  setConfig,
  updateConfig,
} from "./manager.js";
export { rotateConfigPassphrase, unlockOrSetupConfigCipher } from "./cipher.js";
