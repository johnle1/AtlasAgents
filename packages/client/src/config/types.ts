/**
 * Types, on-disk shapes, and constants for the config module.
 *
 * @remarks
 * Holds the public `Config`/`UiConfig` interfaces, the internal
 * `StoredConfig`/`SecretConfigFields` shapes used at the encryption
 * boundary, `DEFAULT_CONFIG`, and the small path/passphrase constants
 * shared between `parsing.ts`, `manager.ts`, and `cipher.ts`.
 */

import * as path from "node:path";
import * as os from "node:os";
import type { SecretsEnvelope } from "@atlasagents/shared";
import type { ApprovalMode, PersistedApprovalMode } from "./approvalMode.js";
import type { SandboxMode } from "../fileProxy/sandbox/index.js";
import { DEFAULT_SANDBOX_IMAGE } from "../fileProxy/sandbox/index.js";

/**
 * Footer / status presentation for a mode (icon + label + Ink color).
 */
export type ApprovalModeDisplay = {
  /** Icon-prefixed label shown in the footer. */
  label: string;
  /** Ink `color` hex when the mode should stand out; omit for dim default. */
  color?: string;
  /** When true, render the label bold (auto). */
  bold?: boolean;
};

/**
 * Footer presentation table for every {@link ApprovalMode}.
 */
export const APPROVAL_MODE_DISPLAY: Record<ApprovalMode, ApprovalModeDisplay> =
  {
    default: { label: "default" },
    accept_edits: { label: "⏵ Accept Edits", color: "#FB923C" },
    plan: { label: "⏸ Plan", color: "#60A5FA" },
    auto: { label: "⏵⏵ Auto", color: "#FF5555", bold: true },
  };

/**
 * `/sandbox` configuration persisted to disk.
 *
 * @remarks
 * Not sensitive — safe to store in plaintext alongside every other
 * non-secret `Config` field.
 */
export interface SandboxConfig {
  /**
   * `"auto"` (default) picks the strongest backend available per-platform;
   * `"container"` forces the container backend even where an OS-native one
   * exists; `"off"` disables sandboxing entirely. See
   * `fileProxy/sandbox/index.ts` for what each mode resolves to.
   */
  mode: SandboxMode;

  /**
   * Image tag the container backend runs commands in. Defaults to the
   * image built from `sandbox/Dockerfile`; override if your project
   * needs a different toolchain baked in.
   */
  containerImage: string;
}

/**
 * One configured MCP (Model Context Protocol) server — connection shape
 * only, never credentials (those live in `mcpSecrets`, encrypted).
 *
 * @remarks
 * `readOnly` is a manual, server-wide override: when set, every tool from
 * this server skips the approval prompt and stays available in plan mode,
 * regardless of what each tool's own MCP `annotations.readOnlyHint` says.
 * Leave unset to trust each tool's own hint (falling back to "not
 * read-only" — the safer default — when a tool declares none).
 *
 * `enabled` (default `true` when absent) lets `/mcp disable <name>` turn a
 * server off without discarding its config/credentials — cheaper and more
 * reversible than `/mcp remove` + re-adding. A disabled server is skipped by
 * the automatic sync (`syncAllMcpTools`) and torn down if currently
 * connected; `/mcp test`/`/mcp tools <name>`, naming it explicitly, still
 * work so you can check it before re-enabling.
 */
export type McpServerConfig =
  | {
      transport: "stdio";
      /** Executable to spawn (e.g. `"npx"`, `"tokensave"`). */
      command: string;
      /** Arguments passed to `command`. */
      args?: string[];
      readOnly?: boolean;
      enabled?: boolean;
    }
  | {
      transport: "http";
      /** MCP streamable-HTTP endpoint URL. */
      url: string;
      readOnly?: boolean;
      enabled?: boolean;
    };

/** The `Config` fields sensitive enough to encrypt at rest. */
export type SecretConfigFields = Pick<
  Config,
  "password" | "server" | "mcpSecrets"
>;

/**
 * On-disk shape of config.json.
 *
 * @remarks
 * `password`/`server` appear at the top level only in a legacy,
 * not-yet-migrated (plaintext) file; once migrated they live exclusively
 * inside `$secrets`. `mcpSecrets` has no such legacy plaintext era — it's
 * always encrypted from the first write. Every other `Config` field stays a
 * plain top-level key either way.
 */
export type StoredConfig = Partial<
  Omit<Config, "password" | "server" | "mcpSecrets">
> & {
  password?: string;
  server?: string;
  $secrets?: SecretsEnvelope;
};

/**
 * Strips the encryption-related fields from a parsed on-disk object, leaving
 * only the plain (non-secret) config fields.
 *
 * @remarks
 * Used everywhere a `StoredConfig` needs to be re-merged or re-saved without
 * carrying along its old `$secrets` envelope or legacy plaintext
 * `password`/`server` — e.g. after a passphrase reset or rotation, where the
 * secret fields are handled separately (encrypted fresh, or intentionally
 * dropped).
 *
 * @param stored - The parsed on-disk object to strip.
 * @returns Every field of `stored` except `$secrets`, `password`, and `server`.
 */
export const omitSecretFields = (
  stored: StoredConfig,
): Partial<Omit<Config, "password" | "server" | "mcpSecrets">> => {
  const rest = { ...stored };
  delete rest.$secrets;
  delete rest.password;
  delete rest.server;
  return rest;
};

/**
 * Consecutive wrong passphrase entries before offering the reset menu.
 *
 * @remarks
 * See {@link unlockOrSetupConfigCipher} — a forgotten passphrase must not be
 * a permanent dead end, but the menu shouldn't appear on a single typo either.
 */
export const MAX_PASSPHRASE_ATTEMPTS = 3;

/** Prompt label reused for both the first-time and post-reset passphrase entry. */
export const NEW_PASSPHRASE_LABEL =
  "Set a passphrase to encrypt your server password and host (entered once per launch): ";

/**
 * UI configuration preferences persisted to disk.
 *
 * @remarks
 * This interface defines the user interface settings that are stored in the
 * config file. These preferences control the visual appearance and behavior
 * of the CLI, such as color themes and display options.
 *
 * @example
 * const uiConfig: UiConfig = {
 *   theme: "ocean",
 *   showSpinner: true,
 *   useAlternateBuffer: false
 * };
 */
export interface UiConfig {
  /**
   * Theme key that maps to a color scheme in the theme registry.
   *
   * @remarks
   * Common values include "default", "ocean", and "vscode-dark". The theme
   * affects how text and UI elements are colored in the terminal.
   */
  theme: string;

  /**
   * Whether to show an animated status spinner during long-running operations.
   *
   * @remarks
   * When true, a spinner animation displays to indicate that the CLI is
   * processing. When false, operations complete without visual feedback.
   * Defaults to true.
   */
  showSpinner?: boolean;

  /**
   * Whether to use the alternate screen buffer for full-screen UI.
   *
   * @remarks
   * When true, the CLI uses the alternate screen buffer (like `less` or `vim`),
   * which clears the terminal and restores it on exit. When false, output is
   * inline with previous terminal content. Defaults to false.
   */
  useAlternateBuffer?: boolean;

  /**
   * Whether to raise a desktop / terminal notification on approval and
   * task-complete edges.
   *
   * @remarks
   * Off by default. Enable with `/notify on`. Uses OSC 9 where the terminal
   * supports it (iTerm2, WezTerm, Ghostty, kitty) and BEL otherwise.
   */
  notifications?: boolean;
}

/**
 * Complete CLI configuration persisted to ~/.atlasagents/config.json.
 *
 * @remarks
 * This interface defines all configuration values for the AtlasAgents client,
 * including server connection settings, model parameters, timeouts, and UI
 * preferences. The config is loaded on startup and can be modified via CLI
 * commands or by editing the JSON file directly.
 *
 * @example
 * const config: Config = {
 *   server: "localhost",
 *   port: 7000,
 *   password: "secret",
 *   agentModel: "gemma3:27b",
 *   subagentModel: "gemma3:4b",
 *   agentTemp: 0.1,
 *   subagentTemp: 0.4,
 *   retries: 3,
 *   timeout: 600000,
 *   shellTimeoutMs: 300000,
 *   maxContextBudget: 0.2,
 *   workspace: "/home/user/projects",
 *   showThinkOutput: false,
 *   subagentCap: 3,
 *   ui: { theme: "default", showSpinner: true, useAlternateBuffer: false }
 * };
 */
export interface Config {
  /**
   * RSocket TCP server hostname or IP address.
   *
   * @remarks
   * This is the TCP host for the RSocket connection, not an HTTP URL.
   * Common values are "localhost" for local development or specific
   * hostnames/IPs for remote servers.
   */
  server: string;

  /**
   * RSocket TCP server port number.
   *
   * @remarks
   * Port 7000 is the conventional default for RSocket servers. The port
   * must match the port the server is configured to listen on.
   */
  port: number;

  /**
   * Shared server password for authentication.
   *
   * @remarks
   * This password is sent on every RSocket frame as metadata in the format
   * `{ "password": "..." }`. The password must match the password the server
   * operator set at server startup. An empty string is allowed for unsecured
   * development environments.
   */
  password: string;

  /**
   * Ollama model name for the agent role.
   *
   * @remarks
   * The agent handles planning and coordination tasks. Use larger models
   * for better reasoning. Example values: "gemma3:27b", "llama3:70b".
   * Empty until set by user or first-run prompts.
   */
  agentModel: string;

  /**
   * Ollama model name for the subagent role.
   *
   * @remarks
   * Subagents handle code generation and execution tasks. Smaller models are
   * typically sufficient for faster response times. Example values: "gemma3:4b",
   * "llama3:8b". Empty until set by user or first-run prompts.
   */
  subagentModel: string;

  /**
   * Provider serving the agent role.
   *
   * @remarks
   * `"ollama"` (the default) talks to the local Ollama instance. Any other
   * value must match a provider added on the server via `/providers add` —
   * e.g. LM Studio, llama.cpp's server, or a hosted OpenAI-compatible API.
   */
  agentProvider: string;

  /**
   * Provider serving the subagent role. Same rules as {@link agentProvider}.
   */
  subagentProvider: string;

  /**
   * Sampling temperature for the agent model (0.0-1.0).
   *
   * @remarks
   * Lower values (e.g., 0.1) produce more deterministic output suitable for
   * planning and coordination. Higher values produce more varied output.
   * Range is 0.0 to 1.0.
   */
  agentTemp: number;

  /**
   * Sampling temperature for the subagent model (0.0-1.0).
   *
   * @remarks
   * Moderate values (e.g., 0.4) balance creativity with reliability for code
   * generation tasks. Lower values are more deterministic, higher values more
   * creative. Range is 0.0 to 1.0.
   */
  subagentTemp: number;

  /**
   * Maximum number of retry attempts for failed server requests.
   *
   * @remarks
   * When a request to the server fails (network error, timeout, etc.), the client
   * will retry up to this many times before giving up. Default is 3 retries.
   */
  retries: number;

  /**
   * Timeout in milliseconds for model responses.
   *
   * @remarks
   * This prevents the CLI from hanging indefinitely on slow or unresponsive models.
   * Default is 600000ms (10 minutes). Adjust based on your model's typical response time.
   */
  timeout: number;

  /**
   * Timeout in milliseconds for shell commands executed via the file proxy.
   *
   * @remarks
   * Shell commands initiated by the server through the file proxy will be killed
   * after this duration. Default is 300000ms (5 minutes) — scaffold/install
   * commands (`npm create`, `npm install`, …) routinely take longer than the
   * old 2-minute default. Increase further for long-running operations,
   * decrease for faster failure detection.
   */
  shellTimeoutMs: number;

  /**
   * Maximum percentage of context window that memory injection can consume.
   *
   * @remarks
   * Memory injection adds context from previous operations to the current prompt.
   * This value caps how much of the model's context window can be used for injected
   * memory. Value is a percentage (0.0 to 1.0). Default is 0.2 (20%).
   */
  maxContextBudget: number;

  /**
   * Default workspace directory for file operations.
   *
   * @remarks
   * This is the security boundary — agents can only read/write files within this
   * directory and its subdirectories. Empty string until set by user via
   * `/workspace set <path>` or by editing config.json.
   */
  workspace: string;

  /**
   * Whether to display agent and subagent "think" boxes in the terminal.
   *
   * @remarks
   * When true, the CLI shows the internal reasoning process of the agent and
   * subagent models. When false, only the final output is displayed. Default
   * is true — seeing what the agent is doing mid-task (especially during a
   * multi-step turn) is the normal expectation; `/think off` opts back out.
   */
  showThinkOutput: boolean;

  /**
   * Maximum number of parallel agent groups when no trigger word is used.
   *
   * @remarks
   * This caps concurrent subagent execution to prevent resource exhaustion. Minimum
   * value is 1. Use `::max` as a special value to indicate no cap. Default is 3.
   */
  subagentCap: number;

  /**
   * Client-side UI preferences.
   *
   * @remarks
   * Contains theme, spinner, and display settings that affect how the CLI
   * renders in the terminal. These are client-only preferences and don't affect
   * server behavior.
   */
  ui: UiConfig;

  /**
   * Session permission mode persisted across launches.
   *
   * @remarks
   * `"default"` | `"accept_edits"` | `"plan"`. `"auto"` (full bypass) is
   * session-only and is never stored here — a hand-edited `"auto"` value
   * is coerced to `"default"` on load.
   */
  approvalMode: PersistedApprovalMode;

  /**
   * `/sandbox` mode and container image — see {@link SandboxConfig}.
   */
  sandbox: SandboxConfig;

  /**
   * Configured MCP servers, keyed by a user-chosen server id (e.g.
   * `"github"`, `"tokensave"`, `"my-tool"`). Connection shape only — never
   * credentials; see {@link mcpSecrets}. Managed via `/mcp add|remove|list`.
   */
  mcpServers: Record<string, McpServerConfig>;

  /**
   * Per-server credential bundles, keyed by the same server id as
   * {@link mcpServers}. Each value is a flat env-var-shaped map: for a
   * `stdio` server these are merged into the spawned process's
   * environment; for an `http` server, a `token` key is sent as
   * `Authorization: Bearer <token>`. Encrypted at rest alongside
   * `password`/`server` — see the Security section of the README.
   */
  mcpSecrets: Record<string, Record<string, string>>;

  /**
   * Pinned SHA-256 fingerprints of server TLS certificates, keyed by `"host:port"`.
   *
   * @remarks
   * The server's certificate is self-signed (there is no CA to validate
   * against), so trust works like an SSH host key: the fingerprint presented
   * on the first connection to a given `host:port` is stored here, and every
   * later connection must present the exact same fingerprint or the client
   * refuses to connect. This is what makes a self-signed certificate safe to
   * use — without it, `rejectUnauthorized: false` would accept any
   * certificate a network attacker cared to present.
   *
   * Not a secret — safe to store in plaintext even in an encrypted config.
   */
  serverFingerprints: Record<string, string>;

  /**
   * `Date.now()` epoch ms of the last write to a model/provider/temperature
   * field the server also tracks — NOT a general file-write timestamp (the
   * config file's own mtime is unusable for this, since it bumps on every
   * unrelated write: theme, sandbox, `/mcp`, `/workspace`, …). Compared
   * against the server's own `configChangedAt`
   * (`packages/server/src/config/types.ts`) by the `sync.check` route to
   * decide which side's overlapping values win on startup: whichever
   * changed more recently.
   */
  configChangedAt: number;
}

/**
 * Default configuration applied on first run or when config.json is missing.
 *
 * @remarks
 * These values are chosen for the atlas use case specifically. They serve
 * as the template when the config file is missing and as the base layer when
 * merging disk JSON with DEFAULT_CONFIG.
 */
export const DEFAULT_CONFIG: Config = {
  // RSocket TCP connection — not HTTP
  server: "localhost",
  port: 7000,

  // Set on first run, /set password, or editing config.json
  password: "",

  // Model names (empty until set by user or first-run prompts)
  agentModel: "",
  subagentModel: "",

  // Native Ollama by default; switched via /providers + /set agent|subagent
  agentProvider: "ollama",
  subagentProvider: "ollama",

  // Low for agent (deterministic planning), moderate for subagents (creative code)
  agentTemp: 0.1,
  subagentTemp: 0.4,

  // Standard retry count — 3 attempts before escalating or failing
  retries: 3,

  // Prevents CLI hanging on slow or unresponsive models (10 minutes)
  timeout: 600_000,

  // Kill shell commands after 5 minutes by default (npm create/install often need longer)
  shellTimeoutMs: 300_000,

  // Caps how much of the context window memory injection can consume (20%)
  maxContextBudget: 0.2,

  // Empty until set via `/workspace set <path>` or editing config.json
  workspace: "",

  // Show agent/subagent think boxes by default; `/think off` opts out
  showThinkOutput: true,

  // Allow 3 parallel subagent groups by default (minimum 1)
  subagentCap: 3,

  // Default UI preferences
  ui: {
    theme: "default",
    showSpinner: true,
    useAlternateBuffer: false,
    notifications: false,
  },

  // Permission mode — Shift+Tab cycles default / accept_edits / plan
  approvalMode: "default",

  // Strongest available backend per-platform; see fileProxy/sandbox/index.ts
  sandbox: {
    mode: "auto",
    containerImage: DEFAULT_SANDBOX_IMAGE,
  },

  // Empty until added via /mcp add (or the bundled TokenSave/GitHub/Jira/Slack presets)
  mcpServers: {},
  mcpSecrets: {},

  // No servers trusted yet — populated on first connect to each host:port (TOFU)
  serverFingerprints: {},

  // 0 means "never explicitly changed" — always loses a newest-wins
  // comparison against a server that has ever had a model set.
  configChangedAt: 0,
};

/** Config directory path (~/.atlasagents) where config, history, and skills live. */
export const CONFIG_DIR = path.join(os.homedir(), ".atlasagents");

/**
 * Pre-rename config directory (`~/.agent-cli`).
 *
 * @remarks
 * {@link ensureDirs} copies this into {@link CONFIG_DIR} once, when the new
 * directory does not exist yet, so existing passphrase, pins, skills, and
 * history survive the AtlasAgents rename.
 */
export const LEGACY_CONFIG_DIR = path.join(os.homedir(), ".agent-cli");

/** Full path to the JSON config file that Connection and /config read from. */
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/**
 * Path to the readline history file for arrow-key command recall.
 *
 * @remarks
 * Exported so index.ts can load and save history on startup/shutdown.
 * History is persisted across CLI sessions for command recall convenience.
 */
export const HISTORY_FILE = path.join(CONFIG_DIR, ".history");

/**
 * Directory where user-created skill markdown files are stored.
 *
 * @remarks
 * Exported so skills.ts can read from and write to this directory.
 * Users can create custom skills as markdown files in this directory.
 */
export const SKILLS_DIR = path.join(CONFIG_DIR, "skills");
