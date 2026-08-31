/**
 * Builds a Router with command and stream handlers for client requests.
 *
 * @remarks
 * This module implements the composition root for the routing layer.
 * It provides factory functions for creating individual handlers and
 * a main `buildRouter` function that assembles them into a configured Router.
 *
 * The refactored design separates concerns by:
 * - Extracting individual handler functions for better testability
 * - Creating shared utilities for common patterns
 * - Separating business logic from routing logic
 * - Fixing identified bugs in the original implementation
 */

import { parseMaxSubagentsPayload } from "../orchestration/maxSubagents.js";
import { normalizeTaskApprovalMode } from "@atlasagents/shared";
import type { PlanDecision } from "../orchestration/types.js";
import { exploreCodebase } from "../orchestration/exploreCodebase.js";
import type {
  CommandHandler,
  RouteId,
  StreamHandler,
  StreamKind,
  IOrchestrator,
  PreferenceRulesTransformer,
  RouterBuilderDeps,
} from "./types.js";
import type { PerConnection } from "../container/types.js";
import { Router } from "./router.js";
import type { TaskFrame } from "../transport/frames.js";
import type { PullProgress } from "../ollama/types.js";
import { OLLAMA_PROVIDER_NAME } from "../providers/providerRegistry.js";
import {
  syncAgentToolSupport,
  syncSubagentToolSupport,
} from "../ollama/syncAgentToolSupport.js";
import { syncAgentThinkingSupport } from "../ollama/syncAgentThinkingSupport.js";
import {
  describeModelPlacement,
  matchRunningModel,
  formatSpillMessage,
} from "../ollama/modelPlacement.js";
import { buildModelStorageReport } from "../ollama/modelStorage.js";
import { isOrchestratorErrorReported } from "../orchestration/taskErrors.js";
import { NotFoundError, ValidationError, AbortError } from "../errors/index.js";
import {
  mcpToolToAtlasSchema,
  type McpToolSyncPayload,
} from "../orchestration/mcp/mcpToolSchema.js";
import type { McpToolsCacheStore } from "../orchestration/mcp/mcpToolsCacheStore.js";
import type { OllamaClient } from "../ollama/client.js";
import type { IOllamaAdminClient } from "../orchestration/interfaces/ollamaInterfaces.js";
import type { IConfigManager } from "../orchestration/interfaces/configInterfaces.js";
import type { ProviderRegistry } from "../providers/providerRegistry.js";
import type { PreferenceRule } from "../orchestration/interfaces.js";
import type { ServerConfig } from "../config/index.js";

export { IOrchestrator, PreferenceRulesTransformer, RouterBuilderDeps };

// ===== SHARED UTILITIES =====

/**
 * Parses a string field from a payload with a default value.
 */
function parseStringField(
  payload: unknown,
  field: string,
  defaultValue: string = "",
): string {
  if (typeof payload === "object" && payload !== null && field in payload) {
    const body = payload as Record<string, unknown>;
    return String(body[field] ?? defaultValue);
  }
  return defaultValue;
}

/**
 * Safely gets a nested object from payload or returns empty object.
 */
function parseObjectField<T>(payload: unknown, field: string): T {
  if (typeof payload === "object" && payload !== null && field in payload) {
    const body = payload as Record<string, unknown>;
    const value = body[field];
    if (typeof value === "object" && value !== null) {
      return value as T;
    }
  }
  return {} as T;
}

/**
 * Drops API keys from a provider map before it crosses the wire to a client.
 *
 * @remarks
 * `providers.list` and `config.get` both expose this map to any authenticated
 * client. `apiKey` is a credential for a third-party model provider (e.g. an
 * OpenAI-compatible endpoint) — no client consumer reads it, only
 * `baseUrl` and the provider name, so it must never be sent. `hasApiKey` is
 * kept (rather than omitting the field entirely) so a future UI can still
 * show "key configured" without ever shipping the secret itself.
 */
export const stripProviderSecrets = (
  providers: Record<string, { baseUrl: string; apiKey?: string }>,
): Record<string, { baseUrl: string; hasApiKey: boolean }> => {
  const stripped: Record<string, { baseUrl: string; hasApiKey: boolean }> = {};
  for (const [name, provider] of Object.entries(providers)) {
    stripped[name] = {
      baseUrl: provider.baseUrl,
      hasApiKey:
        typeof provider.apiKey === "string" && provider.apiKey.length > 0,
    };
  }
  return stripped;
};

// ===== MODEL HANDLERS =====

/**
 * Creates a handler for listing all available models.
 */
function createListModelsHandler(ollama: OllamaClient): CommandHandler {
  return async () => {
    const models = await ollama.listModelsDetailed();
    return { models };
  };
}

/**
 * Best-effort disk-usage snapshot taken around a model delete, wrapped so
 * any failure (directory not local/readable, scan error) yields `undefined`
 * rather than throwing — a `/models storage`-unavailable environment must
 * never break plain deletion.
 */
async function snapshotStorageBytes(
  ollamaBaseUrl: string | undefined,
): Promise<number | undefined> {
  try {
    const report = await buildModelStorageReport(ollamaBaseUrl);
    return report.available ? report.totals.onDiskBytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates a handler for deleting a model with config reference checking.
 */
function createDeleteModelHandler(
  ollama: OllamaClient,
  config: IConfigManager,
  ollamaBaseUrl?: string,
): CommandHandler {
  return async (_session, payload) => {
    const modelName = parseStringField(payload, "name");

    // Snapshot before the real delete call, which is allowed to throw and
    // propagate normally (e.g. "model not found") — the storage snapshot is
    // purely informational and must never gate or mask that.
    const bytesBefore = await snapshotStorageBytes(ollamaBaseUrl);
    await ollama.deleteModel(modelName);
    const bytesAfter =
      bytesBefore === undefined ? undefined : await snapshotStorageBytes(ollamaBaseUrl);
    const freedBytes =
      bytesBefore !== undefined && bytesAfter !== undefined
        ? Math.max(0, bytesBefore - bytesAfter)
        : undefined;

    // Check if deleted model was configured as active
    const currentConfig = (await config.getAll()) as ServerConfig;

    const wasAgentModel =
      String(currentConfig.agentModel ?? "").trim() === modelName;
    const wasSubagentModel =
      String(currentConfig.subagentModel ?? "").trim() === modelName;

    return { ok: true, wasAgentModel, wasSubagentModel, freedBytes };
  };
}

/**
 * Creates a handler reporting real on-disk model storage: per-tag
 * unique/shared bytes and any blob files no installed tag references
 * (orphaned by an interrupted `/models pull`) — read-only, never deletes
 * anything itself.
 */
function createModelStorageHandler(ollamaBaseUrl?: string): CommandHandler {
  return async () => buildModelStorageReport(ollamaBaseUrl);
}

/**
 * Creates a handler for showing detailed model information.
 */
function createShowModelHandler(ollama: OllamaClient): CommandHandler {
  return async (_session, payload) => {
    const modelName = parseStringField(payload, "name");
    return ollama.showModel(modelName);
  };
}

/**
 * Creates a handler for listing running models.
 */
function createListRunningModelsHandler(ollama: OllamaClient): CommandHandler {
  return async () => {
    const models = await ollama.listRunning();
    return { models };
  };
}

// ===== CONFIGURATION HANDLERS =====

/**
 * Creates a handler for getting current configuration.
 */
function createGetConfigHandler(config: IConfigManager): CommandHandler {
  return async () => {
    const fullConfig = await config.getAll();
    const { providers } = fullConfig as ServerConfig;
    return {
      ...fullConfig,
      providers: stripProviderSecrets(providers ?? {}),
    };
  };
}

/**
 * Creates a handler for setting configuration values.
 */
function createSetConfigHandler(
  ollama: OllamaClient,
  config: IConfigManager,
): CommandHandler {
  return async (_session, payload) => {
    const body = payload as { key?: string; value?: unknown };
    const configKey = String(body.key ?? "");
    const configValue = body.value;

    // FIXED: Differentiate between agentModel and subagentModel
    if (configKey === "agentModel") {
      const name = String(configValue ?? "");
      await config.setModel("agent", name);
      const agentModelSupportsTools = await syncAgentToolSupport(
        ollama,
        config,
        name,
      );
      const agentModelSupportsThinking = await syncAgentThinkingSupport(
        ollama,
        config,
        name,
      );
      return { ok: true, agentModelSupportsTools, agentModelSupportsThinking };
    } else if (configKey === "subagentModel") {
      const name = String(configValue ?? "");
      await config.setModel("subagent", name);
      const subagentModelSupportsTools = await syncSubagentToolSupport(
        ollama,
        config,
        name,
      );
      return { ok: true, subagentModelSupportsTools };
    } else {
      await config.set(configKey, configValue);
      if (configKey === "timeout" && typeof configValue === "number") {
        ollama.setTimeoutMs(configValue);
      }
    }
    return { ok: true };
  };
}

/**
 * Best-effort check for whether a just-selected model is already loaded and,
 * if so, whether it's spilling off the GPU — reusing the same measured
 * `/api/ps` classification the task-start check uses (see modelPlacement.ts).
 *
 * @remarks
 * Only reports on a model that happens to already be resident (e.g. it was
 * used in a prior task). A freshly-picked, not-yet-loaded model is not
 * warmed up to check — this intentionally never loads anything on its own,
 * matching the no-warm-up decision for `/set agent|subagent`. Never throws:
 * any failure to reach the provider's admin API just means no warning.
 */
async function checkSelectionPlacement(
  admin: IOllamaAdminClient,
  modelName: string,
): Promise<string | undefined> {
  try {
    const running = await admin.listRunning();
    const runningEntry = matchRunningModel(running, modelName);
    if (!runningEntry) {
      return undefined;
    }
    const placement = describeModelPlacement(runningEntry);
    if (placement.kind === "gpu" || placement.kind === "unknown") {
      return undefined;
    }
    return formatSpillMessage(placement);
  } catch {
    return undefined;
  }
}

/**
 * Creates a handler for setting role-specific models.
 */
function createSetModelHandler(
  config: IConfigManager,
  providerRegistry: ProviderRegistry,
): CommandHandler {
  return async (_session, payload) => {
    const body = payload as {
      role?: string;
      provider?: string;
      model?: string;
    };
    const role = body.role === "agent" ? "agent" : "subagent";
    const providerName = String(body.provider ?? OLLAMA_PROVIDER_NAME);
    const modelName = String(body.model ?? "");

    await config.setRoleModel(role, providerName, modelName);
    const admin = await providerRegistry.getAdmin(providerName);
    const supportsTools =
      role === "agent"
        ? await syncAgentToolSupport(admin, config, modelName)
        : await syncSubagentToolSupport(admin, config, modelName);
    // Only the agent role ever requests Ollama's `think` mode (see the
    // includeThinking comment in subagent.ts) — leave this undefined for
    // subagent rather than probing a capability nothing reads.
    const supportsThinking =
      role === "agent"
        ? await syncAgentThinkingSupport(admin, config, modelName)
        : undefined;

    const placementWarning =
      providerName === OLLAMA_PROVIDER_NAME
        ? await checkSelectionPlacement(admin, modelName)
        : undefined;

    return { ok: true, supportsTools, supportsThinking, placementWarning };
  };
}

// ===== PROVIDER HANDLERS =====

/**
 * Creates a handler for listing all providers.
 */
function createListProvidersHandler(config: IConfigManager): CommandHandler {
  return async () => {
    const providers = await config.getProviders();
    const agentProvider = await config.getAgentProvider();
    const subagentProvider = await config.getSubagentProvider();
    return {
      providers: {
        [OLLAMA_PROVIDER_NAME]: {},
        ...stripProviderSecrets(providers),
      },
      agentProvider,
      subagentProvider,
    };
  };
}

/**
 * Creates a handler for adding a new provider.
 */
function createAddProviderHandler(config: IConfigManager): CommandHandler {
  return async (_session, payload) => {
    const body = payload as {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
    };
    await config.addProvider(String(body.name ?? ""), {
      baseUrl: String(body.baseUrl ?? ""),
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
    });
    return { ok: true };
  };
}

/**
 * Creates a handler for removing a provider.
 */
function createRemoveProviderHandler(config: IConfigManager): CommandHandler {
  return async (_session, payload) => {
    const providerName = parseStringField(payload, "name");
    await config.removeProvider(providerName);
    return { ok: true };
  };
}

/**
 * Creates a handler for listing models from all providers.
 */
function createListProviderModelsHandler(
  providerRegistry: ProviderRegistry,
  config: IConfigManager,
): CommandHandler {
  return async () => {
    const providers = await config.getProviders();
    const providerNames = [OLLAMA_PROVIDER_NAME, ...Object.keys(providers)];

    const groups = await Promise.all(
      providerNames.map(async (name) => {
        try {
          const admin = await providerRegistry.getAdmin(name);
          const models = await admin.listModels();
          return { provider: name, models };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return { provider: name, models: [] as string[], error: message };
        }
      }),
    );

    return { groups };
  };
}

// ===== SKILLS HANDLERS =====

/**
 * Creates a handler for synchronizing skills.
 */
function createSyncSkillsHandler(skills: {
  saveAll: (
    skills: Array<{ name: string; content: string }>,
  ) => Promise<number>;
}): CommandHandler {
  return async (_session, payload) => {
    const body = payload as {
      skills?: Array<{ name: string; content: string }>;
    };
    const savedCount = await skills.saveAll(body.skills ?? []);
    return { saved: savedCount };
  };
}

// ===== MEMORY HANDLERS =====

/**
 * Creates a handler for getting memory entries.
 */
function createGetMemoryHandler(
  prefs: { getAll: () => Promise<PreferenceRule[]> },
  preferenceRulesToMemoryEntries: PreferenceRulesTransformer,
): CommandHandler {
  return async () => {
    const rules = await prefs.getAll();
    return { entries: preferenceRulesToMemoryEntries(rules) };
  };
}

/**
 * Creates a handler for forgetting memory by topic.
 */
function createForgetMemoryHandler(prefs: {
  deleteByTopic: (topic: string) => Promise<number>;
}): CommandHandler {
  return async (_session, payload) => {
    const topic = parseStringField(payload, "topic");
    const removedCount = await prefs.deleteByTopic(topic);
    return { removed: removedCount };
  };
}

/**
 * Creates a handler for clearing all memory.
 */
function createClearMemoryHandler(prefs: {
  clear: () => Promise<void>;
}): CommandHandler {
  return async () => {
    await prefs.clear();
    return { ok: true };
  };
}

// ===== SESSION HANDLERS =====

/**
 * Creates a handler for checking session existence.
 */
function createSessionExistsHandler(session: {
  exists: () => Promise<boolean>;
}): CommandHandler {
  return async () => session.exists();
}

/**
 * Creates a handler for clearing session.
 *
 * @remarks
 * Also drops the connection's carried-over `activePlan` and `conversation`
 * (see `PerConnection`) — `/new` starting a fresh task should not resume a
 * checklist, or refer back to prior turns, from the conversation the user
 * just cleared.
 */
function createClearSessionHandler(
  session: { clear: () => Promise<string> },
  brokerByRequester: Map<string, PerConnection>,
): CommandHandler {
  return async (commandSession) => {
    const message = await session.clear();
    const perConnection = brokerByRequester.get(commandSession.requesterId);
    if (perConnection) {
      perConnection.activePlan = undefined;
      perConnection.conversation = undefined;
    }
    return { message };
  };
}

// ===== MCP HANDLERS =====

/**
 * Creates a handler for synchronizing MCP tools.
 *
 * @remarks
 * `workspaceRoot`/`clientId`/`mcpMarker` are optional in the payload — an
 * older client, or {@link "../../../packages/client/src/commands/tokenSaveHandlers.js".syncTokenSaveTools}
 * (an orphaned-but-still-exported caller that never sends them), must not
 * crash or write a bogus cache entry when they're absent; the sync itself
 * (`perConnection.mcpTools`) still happens unconditionally either way.
 */
export function createMcpToolsSyncHandler(
  mcpToolsCacheStore: McpToolsCacheStore,
  brokerByRequester: Map<string, PerConnection>,
  createPerConnection: (
    requesterId: string,
    emit: (frame: TaskFrame) => void,
  ) => any,
): CommandHandler {
  return async (session, payload) => {
    const body = payload as {
      tools?: McpToolSyncPayload[];
      workspaceRoot?: string;
      clientId?: string;
      mcpMarker?: string;
    };
    let perConnection = brokerByRequester.get(session.requesterId);

    if (!perConnection) {
      const newPerConnection = createPerConnection(
        session.requesterId,
        () => {},
      );
      brokerByRequester.set(session.requesterId, newPerConnection);
      perConnection = newPerConnection;
    }

    if (!perConnection) {
      throw new Error("Failed to create or retrieve per-connection state");
    }

    const rawTools = Array.isArray(body.tools) ? body.tools : [];
    perConnection.mcpTools = rawTools.map((tool) => ({
      schema: mcpToolToAtlasSchema(tool),
      readOnly: tool.readOnly ?? false,
    }));

    if (
      typeof body.workspaceRoot === "string" &&
      typeof body.clientId === "string" &&
      typeof body.mcpMarker === "string"
    ) {
      await mcpToolsCacheStore.set(
        body.clientId,
        body.workspaceRoot,
        body.mcpMarker,
        rawTools,
      );
    }

    return { synced: perConnection.mcpTools.length };
  };
}

/** The six config fields the client and server both track, server-side naming. */
type SyncedConfigValues = {
  agentModel: string;
  subagentModel: string;
  agentProvider: string;
  subagentProvider: string;
  agentTemp: number;
  subagentTemp: number;
};

const readSyncedConfigValues = (
  raw: Record<string, unknown> | undefined,
): SyncedConfigValues | undefined => {
  if (!raw) {
    return undefined;
  }
  return {
    agentModel: String(raw.agentModel ?? ""),
    subagentModel: String(raw.subagentModel ?? ""),
    agentProvider: String(raw.agentProvider ?? "ollama"),
    subagentProvider: String(raw.subagentProvider ?? "ollama"),
    agentTemp: typeof raw.agentTemp === "number" ? raw.agentTemp : 0.1,
    subagentTemp: typeof raw.subagentTemp === "number" ? raw.subagentTemp : 0.4,
  };
};

/**
 * Creates the handler for `sync.check` — the single unified startup
 * reconciliation call, covering both MCP tool cache freshness and
 * newest-timestamp-wins config reconciliation. Replaces the earlier
 * separate `mcp.tools.check` route.
 *
 * @remarks
 * The two halves are independent and wrapped in their own try/catch: a
 * failure reconciling config must not prevent the client from still
 * learning whether it can skip MCP discovery, and vice versa. Either half
 * of the response may be omitted if that half's inputs are missing/invalid
 * or its own logic throws — the client treats a missing half as "nothing to
 * reconcile this round" and falls back to its own existing behavior (full
 * MCP discovery, or no config reconciliation).
 *
 * Config reconciliation, when both `configChangedAt` values differ, always
 * applies the newer side's values to the other — see
 * {@link "../config/configManager.js".ConfigManager.applySyncedConfig} for
 * why the "client wins" branch stamps the client's own `changedAt` on the
 * server rather than `Date.now()`. Capability flags (`*SupportsTools`,
 * `agentModelSupportsThinking`) are only re-probed for a role whose model
 * value actually changed, bounding startup latency to real changes.
 */
export function createSyncCheckHandler(
  mcpToolsCacheStore: McpToolsCacheStore,
  brokerByRequester: Map<string, PerConnection>,
  createPerConnection: (
    requesterId: string,
    emit: (frame: TaskFrame) => void,
  ) => any,
  config: IConfigManager,
  providerRegistry: ProviderRegistry,
): CommandHandler {
  return async (session, payload) => {
    const body = payload as {
      workspaceRoot?: string;
      clientId?: string;
      mcpMarker?: string;
      config?: {
        changedAt?: number;
        values?: Record<string, unknown>;
      };
    };

    const response: { mcp?: unknown; config?: unknown } = {};

    // --- MCP half ---
    try {
      if (
        typeof body.workspaceRoot === "string" &&
        typeof body.clientId === "string" &&
        typeof body.mcpMarker === "string"
      ) {
        const entry = mcpToolsCacheStore.get(body.clientId, body.workspaceRoot);
        if (entry && entry.marker === body.mcpMarker) {
          let perConnection = brokerByRequester.get(session.requesterId);
          if (!perConnection) {
            const newPerConnection = createPerConnection(
              session.requesterId,
              () => {},
            );
            brokerByRequester.set(session.requesterId, newPerConnection);
            perConnection = newPerConnection;
          }
          if (perConnection) {
            perConnection.mcpTools = entry.tools.map((tool) => ({
              schema: mcpToolToAtlasSchema(tool),
              readOnly: tool.readOnly ?? false,
            }));
          }
          response.mcp = { upToDate: true, tools: entry.tools };
        } else {
          response.mcp = { upToDate: false };
        }
      } else {
        response.mcp = { upToDate: false };
      }
    } catch {
      response.mcp = { upToDate: false };
    }

    // --- Config half ---
    try {
      const clientChangedAt = body.config?.changedAt;
      const clientValues = readSyncedConfigValues(body.config?.values);

      if (typeof clientChangedAt === "number" && clientValues) {
        const serverConfig = (await config.getAll()) as ServerConfig;
        const serverChangedAt = serverConfig.configChangedAt ?? 0;

        if (clientChangedAt > serverChangedAt) {
          const previousAgentModel = serverConfig.agentModel;
          const previousSubagentModel = serverConfig.subagentModel;

          await config.applySyncedConfig(clientValues, clientChangedAt);

          if (
            clientValues.agentModel.length > 0 &&
            clientValues.agentModel !== previousAgentModel
          ) {
            const admin = await providerRegistry.getAdmin(
              clientValues.agentProvider,
            );
            await syncAgentToolSupport(admin, config, clientValues.agentModel);
            await syncAgentThinkingSupport(
              admin,
              config,
              clientValues.agentModel,
            );
          }
          if (
            clientValues.subagentModel.length > 0 &&
            clientValues.subagentModel !== previousSubagentModel
          ) {
            const admin = await providerRegistry.getAdmin(
              clientValues.subagentProvider,
            );
            await syncSubagentToolSupport(
              admin,
              config,
              clientValues.subagentModel,
            );
          }

          response.config = { winner: "client", changedAt: clientChangedAt };
        } else if (serverChangedAt > clientChangedAt) {
          response.config = {
            winner: "server",
            changedAt: serverChangedAt,
            values: {
              agentModel: serverConfig.agentModel,
              subagentModel: serverConfig.subagentModel,
              agentProvider: serverConfig.agentProvider,
              subagentProvider: serverConfig.subagentProvider,
              agentTemp: serverConfig.agentTemp,
              subagentTemp: serverConfig.subagentTemp,
            },
          };
        } else {
          response.config = { winner: "same", changedAt: serverChangedAt };
        }
      }
    } catch {
      // Leave response.config undefined — the client just doesn't reconcile
      // config this round rather than failing the whole sync.check call.
    }

    return response;
  };
}

// ===== PLAN HANDLERS =====

/**
 * Creates a handler for responding to plan reviews.
 */
function createPlanRespondHandler(
  brokerByRequester: Map<string, PerConnection>,
): CommandHandler {
  return async (session, payload) => {
    const body = payload as {
      id?: string;
      decision?: string;
      feedback?: string;
    };
    const perConnection = brokerByRequester.get(session.requesterId);

    if (!perConnection) {
      throw new NotFoundError(
        "No active plan review broker for this connection",
      );
    }

    const decision = body.decision as PlanDecision | undefined;
    if (
      decision !== "implement" &&
      decision !== "skip" &&
      decision !== "edit"
    ) {
      throw new ValidationError("Invalid plan decision");
    }

    perConnection.resolvePlan(String(body.id ?? ""), {
      decision,
      feedback: typeof body.feedback === "string" ? body.feedback : undefined,
    });
    return { ok: true };
  };
}

// ===== STREAM HANDLERS =====

/**
 * Builds model overrides from task request body.
 */
function buildModelOverrides(body: Record<string, unknown>) {
  const modelOverrides: {
    agentModel?: string;
    subagentModel?: string;
    agentProvider?: string;
    subagentProvider?: string;
    agentTemp?: number;
    subagentTemp?: number;
    debug?: boolean;
  } = {};

  const stringFields = [
    { key: "agentModel", target: "agentModel" },
    { key: "subagentModel", target: "subagentModel" },
    { key: "agentProvider", target: "agentProvider" },
    { key: "subagentProvider", target: "subagentProvider" },
  ];

  for (const { key, target } of stringFields) {
    if (typeof body[key] === "string" && body[key].length > 0) {
      modelOverrides[target as keyof typeof modelOverrides] = body[key] as any;
    }
  }

  if (typeof body.agentTemp === "number" && Number.isFinite(body.agentTemp)) {
    modelOverrides.agentTemp = body.agentTemp;
  }

  if (
    typeof body.subagentTemp === "number" &&
    Number.isFinite(body.subagentTemp)
  ) {
    modelOverrides.subagentTemp = body.subagentTemp;
  }

  if (body.debug === true) {
    modelOverrides.debug = true;
  }

  return Object.keys(modelOverrides).length > 0 ? modelOverrides : undefined;
}

/**
 * Creates a handler for task execution streaming.
 */
function createTaskStreamHandler(
  orchestrator: IOrchestrator,
  brokerByRequester: Map<string, PerConnection>,
  createPerConnection: (
    requesterId: string,
    emit: (frame: TaskFrame) => void,
  ) => PerConnection,
): StreamHandler {
  return async (session, payload, emit, signal) => {
    const body = payload as {
      text?: string;
      maxSubagents?: unknown;
      agentModel?: string;
      subagentModel?: string;
      agentProvider?: string;
      subagentProvider?: string;
      agentTemp?: number;
      subagentTemp?: number;
      debug?: boolean;
      approvalMode?: unknown;
      clientEnv?: { platform?: string; shell?: string; osRelease?: string };
    };

    const taskText = String(body.text ?? "");
    const maxSubagents = parseMaxSubagentsPayload(body.maxSubagents);
    const approvalMode = normalizeTaskApprovalMode(body.approvalMode);
    const modelOverrides = buildModelOverrides(body);
    const clientEnv =
      typeof body.clientEnv?.platform === "string"
        ? {
            platform: body.clientEnv.platform,
            shell: body.clientEnv.shell,
            osRelease: body.clientEnv.osRelease,
          }
        : undefined;

    let perConnection = brokerByRequester.get(session.requesterId);
    if (!perConnection) {
      perConnection = createPerConnection(session.requesterId, emit);
      brokerByRequester.set(session.requesterId, perConnection);
    } else {
      perConnection.rebindStreamEmit(emit);
    }

    try {
      await orchestrator.runTask(
        session,
        taskText,
        emit,
        signal,
        perConnection,
        modelOverrides,
        maxSubagents,
        approvalMode,
        clientEnv,
      );
      emit({ kind: "done" });
    } catch (error) {
      if (!isOrchestratorErrorReported(error)) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        emit({ kind: "error", message: errorMessage });
      }
      throw error;
    }
  };
}

/**
 * Creates a handler for model pull streaming.
 */
function createModelsPullStreamHandler(ollama: OllamaClient): StreamHandler {
  return async (_session, payload, emit, signal) => {
    const modelName = parseStringField(payload, "name");

    for await (const progress of ollama.pullModel(modelName)) {
      if (signal.aborted) {
        throw new AbortError("Model pull aborted");
      }
      emit({ kind: "progress", data: progress as PullProgress });
    }
    emit({ kind: "done" });
  };
}

/**
 * Creates a handler for codebase exploration streaming.
 */
function createExploreStreamHandler(
  brokerByRequester: Map<string, PerConnection>,
  createPerConnection: (
    requesterId: string,
    emit: (frame: TaskFrame) => void,
  ) => any,
  session: { saveSnapshot: (snapshot: string) => Promise<void> },
): StreamHandler {
  return async (connection, _payload, emit, signal) => {
    let perConnection = brokerByRequester.get(connection.requesterId);
    if (!perConnection) {
      const newPerConnection = createPerConnection(
        connection.requesterId,
        emit,
      );
      brokerByRequester.set(connection.requesterId, newPerConnection);
      perConnection = newPerConnection;
    }

    if (!perConnection) {
      throw new Error("Failed to create or retrieve per-connection state");
    }

    emit({ kind: "token", text: "  Exploring codebase...\n" });

    const explored = await exploreCodebase(
      perConnection.workspace,
      emit,
      signal,
    );
    await session.saveSnapshot(explored.snapshot);

    emit({ kind: "token", text: "  ✓ Codebase snapshot updated.\n" });
    emit({ kind: "done" });
  };
}

// ===== MAIN BUILDER FUNCTION =====

/**
 * Creates a Router with command and stream handlers for client requests.
 *
 * @remarks
 * This function is the main entry point for configuring the routing layer.
 * It uses factory functions to create individual handlers, making the code
 * more testable and maintainable.
 *
 * @param deps - All dependencies needed to construct handlers.
 * @returns A fully configured Router instance.
 */
export const buildRouter = (deps: RouterBuilderDeps): Router => {
  const {
    ollama,
    providerRegistry,
    config,
    skills,
    prefs,
    session,
    orchestrator,
    brokerByRequester,
    createPerConnection,
    mcpToolsCacheStore,
    preferenceRulesToMemoryEntries,
    ollamaBaseUrl,
  } = deps;

  // Build command handlers using factory functions
  const commands: Partial<Record<RouteId, CommandHandler>> = {
    "models.list": createListModelsHandler(ollama),
    "models.delete": createDeleteModelHandler(ollama, config, ollamaBaseUrl),
    "models.show": createShowModelHandler(ollama),
    "models.running": createListRunningModelsHandler(ollama),
    "models.storage": createModelStorageHandler(ollamaBaseUrl),
    "config.get": createGetConfigHandler(config),
    "config.set": createSetConfigHandler(ollama, config),
    "config.setModel": createSetModelHandler(config, providerRegistry),
    "providers.list": createListProvidersHandler(config),
    "providers.add": createAddProviderHandler(config),
    "providers.remove": createRemoveProviderHandler(config),
    "providers.listModels": createListProviderModelsHandler(
      providerRegistry,
      config,
    ),
    "skills.sync": createSyncSkillsHandler(skills),
    "memory.get": createGetMemoryHandler(prefs, preferenceRulesToMemoryEntries),
    "memory.forget": createForgetMemoryHandler(prefs),
    "memory.clear": createClearMemoryHandler(prefs),
    "session.exists": createSessionExistsHandler(session),
    "session.clear": createClearSessionHandler(session, brokerByRequester),
    "mcp.tools.sync": createMcpToolsSyncHandler(
      mcpToolsCacheStore,
      brokerByRequester,
      createPerConnection,
    ),
    "sync.check": createSyncCheckHandler(
      mcpToolsCacheStore,
      brokerByRequester,
      createPerConnection,
      config,
      providerRegistry,
    ),
    "plan.respond": createPlanRespondHandler(brokerByRequester),
  };

  // Build stream handlers using factory functions
  const streams: Partial<Record<StreamKind, StreamHandler>> = {
    task: createTaskStreamHandler(
      orchestrator,
      brokerByRequester,
      createPerConnection,
    ),
    "models.pull": createModelsPullStreamHandler(ollama),
    explore: createExploreStreamHandler(
      brokerByRequester,
      createPerConnection,
      session,
    ),
  };

  return new Router({ commands, streams });
};
