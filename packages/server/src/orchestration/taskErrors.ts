/**
 * Error enrichment and formatting functions for orchestration failures.
 *
 * @remarks
 * Converts low-level network errors into actionable user-facing messages.
 * Enhances Ollama connection errors with specific guidance and tips. Formats
 * orchestrator failure messages with context and troubleshooting steps.
 */

import { ConfigError } from "../config/configManager/index.js";
import { AppError } from "../errors/appError.js";
import { OllamaError } from "../ollama/types.js";

const ORCHESTRATOR_ERROR_REPORTED = Symbol("orchestratorErrorReported");

/**
 * Marks an error as already emitted to the client as a formatted error frame.
 *
 * @remarks
 * Attaches a symbol property to the error object to prevent duplicate error
 * messages from being sent to the client. Used by orchestratorPipeline to track
 * which errors have already been reported.
 *
 * @param error - The error to mark as reported
 */
export const markOrchestratorErrorReported = (error: unknown): void => {
  if (typeof error === "object" && error !== null) {
    (error as { [ORCHESTRATOR_ERROR_REPORTED]?: boolean })[
      ORCHESTRATOR_ERROR_REPORTED
    ] = true;
  }
};

/**
 * Returns true when orchestratorPipeline already emitted this error to the client.
 *
 * @remarks
 * Checks for the presence of the ORCHESTRATOR_ERROR_REPORTED symbol property
 * on the error object. Used to avoid duplicate error reporting.
 *
 * @param error - The error to check
 *
 * @returns True if the error has already been reported
 */
export const isOrchestratorErrorReported = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { [ORCHESTRATOR_ERROR_REPORTED]?: boolean })[
    ORCHESTRATOR_ERROR_REPORTED
  ] === true;

/**
 * Maps orchestration phase identifiers to human-readable labels.
 *
 * @remarks
 * Used in error messages to tell users where in the orchestration process the
 * failure occurred (e.g., "agent planning" vs "subagent execution").
 */
const PHASE_LABELS: Record<string, string> = {
  init: "startup",
  context: "loading context / model metadata",
  "agent.plan": "agent planning",
  "agent.pool": "subagent execution",
  "emit.single": "returning agent result",
  "agent.combine": "combining agent results",
};

/**
 * Walks the error cause chain to extract errno-style network error codes.
 *
 * @remarks
 * Walks the error cause chain (up to 8 levels to prevent infinite loops) looking
 * for objects with a "code" property. Extracts the code and any associated message.
 * Returns null if no code is found. Bounded to avoid cyclic cause chains.
 *
 * @param error - The error object to analyze
 *
 * @returns Network error code with message (e.g., "ECONNREFUSED: Connection refused"), or null
 */
export const extractNetworkCause = (error: unknown): string | null => {
  let currentError: unknown = error;

  for (let depth = 0; depth < 8 && currentError != null; depth += 1) {
    if (
      typeof currentError === "object" &&
      "code" in currentError &&
      typeof (currentError as { code: unknown }).code === "string" &&
      !(currentError instanceof AppError)
    ) {
      const errorCode = (currentError as { code: string }).code;
      const errorMessage =
        currentError instanceof Error && currentError.message
          ? `: ${currentError.message}`
          : "";
      return `${errorCode}${errorMessage}`;
    }

    currentError =
      currentError instanceof Error
        ? (currentError as Error & { cause?: unknown }).cause
        : null;
  }

  return null;
};

/**
 * Enriches generic Ollama fetch errors with actionable connection messages.
 *
 * @remarks
 * Checks if error is already an OllamaError (no enrichment needed). Detects
 * timeout errors and provides specific guidance (model may be too large or still
 * loading). Detects connection refused errors and provides troubleshooting steps
 * (ensure Ollama is running). Returns enriched error or original error if no
 * enrichment needed.
 *
 * @param baseUrl - The Ollama server base URL
 * @param operation - The operation being performed (e.g., "chat stream")
 * @param model - The model being accessed (if applicable)
 * @param error - The raw error from the fetch call
 *
 * @returns Enriched error with actionable guidance
 */
export const enrichOllamaFetchError = (
  baseUrl: string,
  operation: string,
  model: string | undefined,
  error: unknown,
): Error => {
  if (error instanceof OllamaError) {
    return error;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const networkCause = extractNetworkCause(error);
  const errorName = error instanceof Error ? error.name : "";
  const modelHint = model ? ` (model: ${model})` : "";

  const isTimeoutError =
    errorName.includes("TimeoutError") ||
    errorMessage.includes("UND_ERR_HEADERS_TIMEOUT") ||
    errorMessage.includes("UND_ERR_BODY_TIMEOUT") ||
    (networkCause?.includes("TIMEOUT") ?? false) ||
    (networkCause?.includes("Timeout") ?? false);

  if (isTimeoutError) {
    const timeoutDetail = new Error(
      `Ollama at ${baseUrl} timed out during ${operation}${modelHint}.` +
        (networkCause ? ` (${networkCause})` : "") +
        " The model may be too large or still loading. Try a smaller model," +
        " pre-load it with `ollama run <model>`, or retry once it is warm.",
    );
    timeoutDetail.cause = error;
    return timeoutDetail;
  }

  if (
    errorMessage === "fetch failed" ||
    networkCause?.includes("ECONNREFUSED")
  ) {
    const connectionDetail = new Error(
      `Cannot reach Ollama at ${baseUrl} during ${operation}${modelHint}.` +
        (networkCause ? ` Network: ${networkCause}.` : "") +
        " Ensure Ollama is running (`ollama serve`) and models are pulled.",
    );
    connectionDetail.cause = error;
    return connectionDetail;
  }

  if (error instanceof Error) {
    return error;
  }
  return new Error(errorMessage);
};

/**
 * Context information for orchestrator failure formatting.
 *
 * @remarks
 * Provides context about where and why the orchestrator failed to format
 * user-friendly error messages. Used by formatOrchestratorFailure to add
 * relevant details to error messages.
 */
export type OrchestratorFailureContext = {
  /** The orchestration phase where failure occurred */
  phase: string;

  /** The agent model being used (if applicable) */
  agentModel?: string;

  /** The subagent model being used (if applicable) */
  subagentModel?: string;
};

/**
 * Formats a multi-line error message for terminal display during orchestrator failures.
 *
 * @remarks
 * Handles ConfigError specially (already formatted). Gets human-readable phase
 * label and adds the main error message. Adds network details if available and
 * not already in message. Adds model information if available. Adds specific
 * tips based on error type (timeout vs connection).
 *
 * @param error - The error that occurred
 * @param context - Context about the failure
 *
 * @returns Formatted multi-line error message for display
 */
export const formatOrchestratorFailure = (
  error: unknown,
  context: OrchestratorFailureContext,
): string => {
  if (error instanceof ConfigError) {
    return error.message;
  }

  const phaseLabel = PHASE_LABELS[context.phase] ?? context.phase;
  const errorLines: string[] = [`Task failed during ${phaseLabel}.`];

  const errorMessage = error instanceof Error ? error.message : String(error);
  errorLines.push(errorMessage);

  const networkCause = extractNetworkCause(error);
  if (
    networkCause &&
    !errorMessage.includes(networkCause) &&
    errorMessage !== "fetch failed" &&
    !errorMessage.includes("Network:")
  ) {
    errorLines.push(`Network detail: ${networkCause}`);
  }

  if (context.agentModel) {
    errorLines.push(`Agent model: ${context.agentModel}`);
  }
  if (context.subagentModel && context.phase === "agent.pool") {
    errorLines.push(`Subagent model: ${context.subagentModel}`);
  }

  const isTimeout =
    errorMessage.includes("timed out") ||
    errorMessage.includes("TIMEOUT") ||
    (networkCause?.toUpperCase().includes("TIMEOUT") ?? false);

  if (isTimeout) {
    errorLines.push(
      "Tip: pre-load the model with `ollama run " +
        (context.subagentModel ?? "<model>") +
        "` or pick a smaller model, then retry.",
    );
  } else if (
    errorMessage === "fetch failed" ||
    networkCause?.includes("ECONNREFUSED")
  ) {
    errorLines.push(
      "Tip: start Ollama with `ollama serve`, then verify with `ollama list`.",
    );
  }

  return errorLines.join("\n");
};
