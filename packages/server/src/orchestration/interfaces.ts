/**
 * <Summary>
 * What it does:
 *   Dependency contracts for the orchestration layer so Advisor, Agent, and
 *   AdvisorOrchestrator compile before concrete Ollama, config, memory, and
 *   skills implementations exist.
 *
 * How it fits in the system:
 *   Defines interfaces that decouple orchestration from concrete implementations.
 *   Server bootstrap will eventually construct real classes implementing these
 *   interfaces and inject them into AdvisorOrchestrator. This enables dependency
 *   injection and makes the system more testable and modular.
 * </Summary>
 */

// Re-export all interfaces from focused files
// This provides a single import point for all orchestration interfaces
export * from "./interfaces/preferenceInterfaces.js";
export * from "./interfaces/ollamaInterfaces.js";
export * from "./interfaces/configInterfaces.js";
export * from "./interfaces/sessionInterfaces.js";
export * from "./interfaces/contextInterfaces.js";
export * from "./interfaces/skillInterfaces.js";
export * from "./interfaces/experienceInterfaces.js";

// Re-export types from other modules used in orchestration
// These are types from memory and ollama modules that orchestration needs
export type {
  CommandOutput,
  ExperienceRecord,
  SessionSummary,
} from "../memory/types.js";

export type {
  ModelInfo,
  OllamaModelSummary,
  PullProgress,
  RunningModel,
} from "../ollama/types.js";

// Re-export error type from ollama module
export { OllamaError } from "../ollama/types.js";
