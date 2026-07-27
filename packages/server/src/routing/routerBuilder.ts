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
import { isOrchestratorErrorReported } from "../orchestration/taskErrors.js";
import { NotFoundError, ValidationError, AbortError } from "../errors/index.js";
import {
  mcpToolToLoopySchema,
  type McpToolSyncPayload,
} from "../orchestration/mcp/mcpToolSchema.js";
import type { OllamaClient } from "../ollama/client.js";
import type { IConfigManager } from "../orchestration/interfaces/configInterfaces.js";
import type { ProviderRegistry } from "../providers/providerRegistry.js";
import type { PreferenceRule } from "../orchestration/interfaces.js";
import type { ServerConfig } from "../config/configManager/index.js";

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
  if (
    typeof payload === "object" &&
    payload !== null &&
    field in payload
  ) {
    const body = payload as Record<string, unknown>;
    return String(body[field] ?? defaultValue);
  }
  return defaultValue;
}

/**
 * Safely gets a nested object from payload or returns empty object.
 */
function parseObjectField<T>(payload: unknown, field: string): T {
  if (
    typeof payload === "object" &&
    payload !== null &&
    field in payload
  ) {
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
 * client. `apiKey` is a credential for a third-party model provider (e.g. a
 * vLLM/OpenAI-compatible endpoint) — no client consumer reads it, only
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
 * Creates a handler for deleting a model with config reference checking.
 */
function createDeleteModelHandler(
  ollama: OllamaClient,
  config: IConfigManager,
): CommandHandler {
  return async (_session, payload) => {
    const modelName = parseStringField(payload, "name");
    await ollama.deleteModel(modelName);

    // Check if deleted model was configured as active
    const currentConfig = (await config.getAll()) as ServerConfig;

    const wasAgentModel =
      String(currentConfig.agentModel ?? "").trim() === modelName;
    const wasSubagentModel =
      String(currentConfig.subagentModel ?? "").trim() === modelName;

    return { ok: true, wasAgentModel, wasSubagentModel };
  };
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
      return { ok: true, agentModelSupportsTools };
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

    return { ok: true, supportsTools };
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
      providers: { [OLLAMA_PROVIDER_NAME]: {}, ...stripProviderSecrets(providers) },
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
 */
function createClearSessionHandler(session: {
  clear: () => Promise<string>;
}): CommandHandler {
  return async () => {
    const message = await session.clear();
    return { message };
  };
}

// ===== MCP HANDLERS =====

/**
 * Creates a handler for synchronizing MCP tools.
 */
function createMcpToolsSyncHandler(
  brokerByRequester: Map<string, PerConnection>,
  createPerConnection: (
    requesterId: string,
    emit: (frame: TaskFrame) => void,
  ) => any,
): CommandHandler {
  return async (session, payload) => {
    const body = payload as { tools?: McpToolSyncPayload[] };
    let perConnection = brokerByRequester.get(session.requesterId);

    if (!perConnection) {
      const newPerConnection = createPerConnection(session.requesterId, () => {});
      brokerByRequester.set(session.requesterId, newPerConnection);
      perConnection = newPerConnection;
    }

    if (!perConnection) {
      throw new Error("Failed to create or retrieve per-connection state");
    }

    const rawTools = Array.isArray(body.tools) ? body.tools : [];
    perConnection.tokenSaveTools = rawTools.map(mcpToolToLoopySchema);
    return { synced: perConnection.tokenSaveTools.length };
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
    };

    const taskText = String(body.text ?? "");
    const maxSubagents = parseMaxSubagentsPayload(body.maxSubagents);
    const modelOverrides = buildModelOverrides(body);

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
      const newPerConnection = createPerConnection(connection.requesterId, emit);
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
    preferenceRulesToMemoryEntries,
  } = deps;

  // Build command handlers using factory functions
  const commands: Partial<Record<RouteId, CommandHandler>> = {
    "models.list": createListModelsHandler(ollama),
    "models.delete": createDeleteModelHandler(ollama, config),
    "models.show": createShowModelHandler(ollama),
    "models.running": createListRunningModelsHandler(ollama),
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
    "session.clear": createClearSessionHandler(session),
    "mcp.tools.sync": createMcpToolsSyncHandler(
      brokerByRequester,
      createPerConnection,
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
