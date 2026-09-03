/**
 * Foundational types, error class, and defaults for the config module:
 * `ServerConfig` (the merged shape every getter reads from), `ConfigRole`,
 * `ConfigError`, `SERVER_DEFAULTS`, and small constants shared between
 * `parsing.ts` and `manager.ts`.
 */

import type { EffortLevel } from "@atlasagents/shared";

// ===== CONSTANTS =====
/**
 * Relative path to persisted config under the server data root.
 * Combined with root directory to form the full config file path.
 */
export const CONFIG_REL_PATH = "user-data/config.json";

/**
 * Consecutive wrong passphrase entries before offering the reset menu.
 *
 * @remarks
 * See {@link ConfigManager.unlockOrSetupProvidersCipher} — a forgotten
 * passphrase must not be a permanent dead end, but the menu shouldn't
 * appear on a single typo either.
 */
export const MAX_PASSPHRASE_ATTEMPTS = 3;

/**
 * Prompt label reused for both the first-time and post-reset passphrase entry.
 *
 * @remarks
 * One passphrase now protects three things — the server auth password, the
 * TCP port, and provider API keys — encrypted under a shared key/salt across
 * `user-data/startup.json` and `user-data/config.json`. See
 * `startupSecrets.ts` for how the two files share that state.
 */
export const NEW_PASSPHRASE_LABEL =
  "Set a passphrase to encrypt your server password, port, and provider API keys (entered once per server start): ";

/** Prompt label reused everywhere an already-set passphrase is entered. */
export const EXISTING_PASSPHRASE_LABEL = "Enter your server config passphrase: ";

/**
 * Ollama's KV-cache quantization modes, from least to most memory-efficient.
 * Defined here (rather than in `ollama/runtimeTuning.ts`, which derives the
 * default) so `runtimeTuning.ts` can import it without creating a cycle back
 * into `config/types.ts`.
 */
export type KvCacheType = "f16" | "q8_0" | "q4_0";

/**
 * How much the agent turn's REASON phase (`orchestration/agent/reasoner.ts`)
 * re-deliberates before acting. Re-exported from `@atlasagents/shared` (see
 * that module's doc comment for the full per-level table) so the client's
 * `/effort` picker and this module's validation share one literal list with
 * no risk of drift.
 */
export { EFFORT_LEVELS, type EffortLevel } from "@atlasagents/shared";

/**
 * Built-in fallback defaults applied when config keys are missing from disk.
 *
 * **Purpose:**
 * Ensures the server always has valid configuration values even when:
 * - config.json doesn't exist yet
 * - config.json is missing certain keys (partial config)
 * - User hasn't customized a setting
 *
 * **Application:**
 * Merged with loaded config in `mergeConfig()`. Stored config values override
 * these defaults; missing keys fall back to these defaults.
 *
 * **Tuning:**
 * These defaults represent sensible starting points for a typical local
 * AtlasAgents development setup. Users can override any value via `/set` command.
 */
export const SERVER_DEFAULTS = {
  /**
   * **agentTemp: 0.1** — Temperature for task planning (Agent model)
   *
   * Lower temperature (toward 0.0) makes the model more deterministic and focused.
   * Agent is responsible for breaking down tasks into a DAG of subtasks, so lower
   * temperature ensures consistent, predictable plans. Values like 0.0–0.3 work well.
   *
   * Typical range: 0.0 (fully deterministic) to 1.0 (fully random)
   */
  agentTemp: 0.1,

  /**
   * **subagentTemp: 0.4** — Temperature for task execution (Subagent model)
   *
   * Slightly higher temperature than agent allows some creativity and flexibility
   * when generating code or writing documentation. Still conservative enough to
   * avoid wild off-topic responses. Values like 0.2–0.6 work well.
   *
   * Typical range: 0.0 (fully deterministic) to 1.0 (fully random)
   */
  subagentTemp: 0.4,

  /**
   * **retries: 3** — Maximum retry attempts for failed subtasks
   *
   * When a subagent fails to complete a task (syntax error, compilation failure, etc.),
   * it retries with the error feedback and guidance up to this many times. More retries
   * increase robustness but also time-to-completion. 3 retries is a good balance.
   *
   * Typical range: 0–5 attempts
   */
  retries: 3,

  /**
   * **timeout: 600_000** — Default operation timeout in milliseconds (10 minutes)
   *
   * Maximum time allowed for any single task execution. Prevents hangs on stuck
   * operations. 10 minutes is generous for complex LLM work; smaller timeouts (30–120s)
   * are common for quick operations.
   *
   * Typical range: 5_000ms (5s, quick) to 600_000ms (10m, complex tasks)
   */
  timeout: 600_000,

  /**
   * **maxContextBudget: 0.2** — Maximum fraction of context reserved for system use
   *
   * When building LLM context windows, ContextBuilder reserves this fraction (20%)
   * for system messages, metadata, and formatting. The remaining 80% goes to user
   * preferences, session history, and current task. Higher values (e.g., 0.3) reduce
   * space for user context; lower values (e.g., 0.1) tighten system constraints.
   *
   * Typical range: 0.1–0.4 (10%–40% reservation)
   */
  maxContextBudget: 0.2,

  /**
   * **agentModelSupportsTools: false** — Does agent model support native tool_calls?
   *
   * When true: agent uses Ollama's native tool_calls API (structured tool invocation)
   * When false: agent uses legacy <<TOOL>>...<</TOOL>> text markers
   *
   * Most current Ollama models still use text markers. Enable this only for models
   * that explicitly support `tools` in their request schema.
   *
   * See: ollama/modelCapabilities.ts for model-specific tool support detection
   */
  agentModelSupportsTools: false,

  /**
   * **subagentModelSupportsTools: false** — Does subagent model support native tool_calls?
   *
   * When true: subagent uses Ollama's native tool_calls API (structured tool invocation)
   * When false: subagent uses legacy <<TOOL>>...<</TOOL>> text markers
   *
   * See: agentModelSupportsTools above; same logic applies.
   */
  subagentModelSupportsTools: false,

  /**
   * **agentModelSupportsThinking: false** — Does the agent model support Ollama's `think` mode?
   *
   * When true: the agent's planning call requests Ollama's extended reasoning
   * output (`think: true`)
   * When false: thinking is omitted from the request entirely
   *
   * Ollama rejects `think: true` with an HTTP 400 for models that don't
   * advertise the `"thinking"` capability, so this must be probed before
   * enabling it — never hardcode `true` at the call site.
   *
   * See: ollama/modelCapabilities.ts for model-specific thinking support detection.
   * There is no subagent equivalent — the subagent's execution call
   * deliberately never requests thinking (see subagent.ts).
   */
  agentModelSupportsThinking: false,

  /**
   * **agentProvider / subagentProvider: "ollama"** — Which provider serves each role.
   *
   * A provider name of "ollama" always resolves to the native local Ollama client.
   * Any other value must have a matching entry in `providers` (added via
   * `/providers add` or ConfigManager.addProvider), pointing at an OpenAI-compatible
   * endpoint (LM Studio, llama.cpp's server, a hosted API, ...).
   */
  agentProvider: "ollama",
  subagentProvider: "ollama",

  /**
   * **keepAlive: "30m"** — How long Ollama keeps a model resident in VRAM after use.
   *
   * Passed as Ollama's `keep_alive` request field. Ollama's own default is 5 minutes;
   * after that, an idle model is evicted and the next request pays a full reload
   * (tens of seconds for a large model) before generating a token. 30 minutes covers
   * typical gaps between tasks without holding VRAM indefinitely on a shared box.
   *
   * Accepts Ollama's duration syntax as a string (e.g. `"30m"`, `"1h"`), or the
   * number `-1` to never unload. Note that never-unload must be the JSON number
   * `-1`, not the string `"-1"`: Ollama parses a string `keep_alive` with Go's
   * `time.ParseDuration`, which rejects a bare `-1` for having no unit and
   * fails the request with a 400.
   */
  keepAlive: "30m",

  /**
   * **effort: "medium"** — How much the REASON phase re-deliberates before
   * acting. See {@link EFFORT_LEVELS}'s doc comment for the full table;
   * `"medium"` keeps the REASON phase's fixed per-step cost (a reasoning
   * call plus one finish-verification pass) as low as it can be while
   * still running the phase at all — `"low"` skips it entirely, and every
   * level above `"medium"` only adds latency that pays off once a decision
   * is already stuck looping, not on the common, fast-converging step.
   */
  effort: "medium" as EffortLevel,

  // 0 means "never explicitly changed" — always loses a newest-wins
  // comparison against any client that has ever set a model, which is
  // correct: an unconfigured server should adopt the client's config.
  configChangedAt: 0,
} as const;

/**
 * <Summary>
 * What it does:
 *   Custom error type for configuration-related failures.
 *
 * How it fits in the system:
 *   Thrown when agentModel or subagentModel is missing from persisted config,
 *   or when invalid configuration operations are attempted. Allows callers
 *   to distinguish configuration errors from other error types.
 *
 * Used by:
 *   - ConfigManager methods — thrown when validation fails.
 * </Summary>
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * <Summary>
 * What it does:
 *   Defines the complete shape of server configuration after merging defaults.
 *
 * Used by:
 *   - ConfigManager — type for loaded and stored configuration.
 *   - mergeConfig — return type for configuration merging.
 *
 * Produced by:
 *   - mergeConfig — creates this type from stored data and defaults.
 * </Summary>
 */
export type ServerConfig = {
  /**
   * Ollama model name for agent (planning and coordination).
   * Must be a valid model name available in the local Ollama instance.
   * Empty string indicates not yet configured.
   */
  agentModel: string;

  /**
   * Ollama model name for subagent (task execution and code generation).
   * Must be a valid model name available in the local Ollama instance.
   * Empty string indicates not yet configured.
   */
  subagentModel: string;

  /**
   * When true, agent model uses native Ollama tool calling API.
   */
  agentModelSupportsTools: boolean;

  /**
   * When true, subagent model uses native Ollama tool calling API.
   */
  subagentModelSupportsTools: boolean;

  /**
   * When true, the agent model supports Ollama's extended `think` mode.
   */
  agentModelSupportsThinking: boolean;

  /**
   * Temperature setting for agent model (0.0 to 1.0).
   * Lower values produce more deterministic, focused responses.
   */
  agentTemp: number;

  /**
   * Temperature setting for subagent model (0.0 to 1.0).
   * Higher values allow more creative, varied responses.
   */
  subagentTemp: number;

  /**
   * Number of retry attempts for failed operations.
   * Provides resilience against transient failures.
   */
  retries: number;

  /**
   * Operation timeout in milliseconds.
   * Prevents indefinite hanging on long-running operations.
   */
  timeout: number;

  /**
   * Maximum fraction of context budget for system use (0.0 to 1.0).
   * Reserved space for system messages and metadata in LLM context.
   */
  maxContextBudget: number;

  /**
   * ISO timestamp of last preference consolidation run.
   * Used to schedule periodic consolidation operations.
   */
  lastConsolidatedAt?: string;

  /**
   * Provider name serving the agent (planning) role. "ollama" (the default)
   * always resolves to the native local Ollama client; any other value must
   * have a matching entry in `providers`.
   */
  agentProvider: string;

  /**
   * Provider name serving the subagent (execution) role. Same rules as
   * agentProvider.
   */
  subagentProvider: string;

  /**
   * Non-Ollama provider connection details, keyed by provider name.
   * "ollama" is reserved and never stored here — it is built in.
   */
  providers: Record<string, { baseUrl: string; apiKey?: string }>;

  /**
   * Ollama runtime context window (`num_ctx`), in tokens. Ollama-only —
   * ignored by OpenAI-compatible providers.
   *
   * Deliberately has no default: when unset, the effective value falls back
   * to Ollama's own default (4096) rather than a guessed number. Set via
   * `/set numCtx`.
   */
  numCtx?: number;

  /**
   * How many concurrent requests Ollama itself will serve at once
   * (`OLLAMA_NUM_PARALLEL`, set as an env var when this process spawns
   * `ollama serve` — see `ollama/lifecycle.ts` / `ollama/runtimeTuning.ts`).
   * Ollama-only; ignored by OpenAI-compatible providers.
   *
   * Deliberately has no default, and unset does NOT mean "guess a value" —
   * it means the env var is omitted entirely, so Ollama performs its own
   * hardware-aware detection (via the CUDA/Metal/ROCm APIs it already links
   * against) and picks a slot count for the real device it's running on.
   * That's strictly better information than this codebase could derive —
   * an earlier version tried estimating from `os.totalmem()`, which is only
   * a valid proxy on unified-memory systems (Apple Silicon) and is
   * confidently wrong on a discrete-GPU machine, where system RAM and VRAM
   * are different pools of very different sizes. Set this only if you want
   * to override Ollama's own choice. **Only takes effect when this process
   * actually spawns Ollama** — if Ollama was already running, the env can't
   * be applied retroactively (see `ensureOllamaRunning`'s early-return path).
   */
  numParallel?: number;

  /**
   * Whether to set `OLLAMA_FLASH_ATTENTION=1` when spawning `ollama serve`.
   * Ollama-only; ignored by OpenAI-compatible providers.
   *
   * Deliberately has no default: unset means "let `runtimeTuning.ts`
   * decide," which currently always means `true` — flash attention is a
   * speed/memory win with no meaningful quality trade-off for coding-agent
   * use on any backend, so unlike `numParallel` it needs no per-machine
   * detection (or lack thereof) at all. Same "only applies if this process
   * spawns Ollama" caveat.
   */
  flashAttention?: boolean;

  /**
   * `OLLAMA_KV_CACHE_TYPE` — quantization of Ollama's KV cache. `"q8_0"`
   * roughly halves KV-cache memory versus `"f16"` for near-lossless
   * quality, freeing headroom for more `numParallel` slots or a larger
   * `numCtx`. Ollama-only; ignored by OpenAI-compatible providers.
   *
   * Deliberately has no default — see `numParallel`'s doc comment; unset
   * means `runtimeTuning.ts` picks `"q8_0"`. Same spawn-time-only caveat.
   */
  kvCacheType?: KvCacheType;

  /**
   * How long Ollama keeps a model resident after use (`keep_alive`).
   * Ollama-only — ignored by OpenAI-compatible providers.
   *
   * @remarks
   * A string carries Ollama's duration syntax (`"30m"`, `"1h"`, `"90s"`). The
   * number `-1` means never unload — it must be a number, since Ollama parses
   * a *string* `keep_alive` with Go's `time.ParseDuration`, which rejects
   * `"-1"` for having no unit. `ConfigManager.set` normalizes the string
   * `"-1"` to the number for exactly that reason.
   */
  keepAlive: string | number;

  /**
   * How much the agent turn's REASON phase re-deliberates before acting.
   * See {@link EFFORT_LEVELS}.
   */
  effort: EffortLevel;

  /**
   * `Date.now()` epoch ms of the last write to any field the client also
   * tracks (agent/subagent model, provider, or temperature) — NOT a general
   * file-write timestamp. Compared against the client's own
   * `configChangedAt` (`packages/client/src/config/types.ts`) by the
   * `sync.check` route to decide which side's overlapping config values win
   * on startup: whichever changed more recently. Deliberately excludes
   * unrelated writes (e.g. `numCtx`, `retries`) so an unrelated `/set` call
   * doesn't falsely look newer than a real model change on the other side.
   */
  configChangedAt: number;
};

/**
 * <Summary>
 * What it does:
 *   Distinguishes between agent and subagent configuration roles.
 *
 * Used by:
 *   - ConfigManager.setModel — specifies which model to update.
 *   - ConfigManager.getTemperature — selects temperature by role.
 *   - Model change callbacks — identifies which model changed.
 * </Summary>
 */
export type ConfigRole = "agent" | "subagent";
