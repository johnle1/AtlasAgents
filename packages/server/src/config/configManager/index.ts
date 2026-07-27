/**
 * Public entry point for the config module.
 *
 * @remarks
 * The implementation is split across sibling files by responsibility:
 * - `mutex.ts` — generic promise-based mutex, no config-specific knowledge.
 * - `types.ts` — `ServerConfig`, `ConfigRole`, `ConfigError`, `SERVER_DEFAULTS`.
 * - `parsing.ts` — validates raw disk JSON into a `ServerConfig` (the only
 *   place that trusts unvalidated `unknown` data).
 * - `manager.ts` — the `ConfigManager` class itself: disk I/O, the
 *   passphrase-encrypted `providers` cipher, and the typed getters/setters
 *   every other service calls.
 *
 * Re-exports exactly what `config/configManager.ts` exported before this
 * split, so no import path outside this folder needs to change beyond
 * pointing at `configManager/index.js` instead of `configManager.js`.
 */

export { SERVER_DEFAULTS, ConfigError, type ServerConfig, type ConfigRole } from "./types.js";
export { ConfigManager } from "./manager.js";
