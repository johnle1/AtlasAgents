/**
 * Dependency contracts for the orchestration layer.
 *
 * @remarks
 * Defines interfaces that decouple orchestration from concrete implementations.
 * Server bootstrap constructs real classes implementing these interfaces and
 * injects them into AgentOrchestrator. This enables dependency injection and
 * makes the system more testable and modular. Allows Agent, Subagent, and
 * AgentOrchestrator to compile before concrete Ollama, config, memory, and
 * skills implementations exist.
 *
 * Re-exports all interfaces from focused files to provide a single import point
 * for all orchestration interfaces. Also re-exports types from memory and ollama
 * modules that orchestration needs.
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
