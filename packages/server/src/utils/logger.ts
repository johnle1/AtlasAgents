/**
 * Centralized logger instance using pino for structured logging.
 *
 * @remarks
 * Provides a consistent logging interface throughout the application.
 * Replaces console.log calls with structured logging that includes timestamps,
 * log levels, and formatted output.
 *
 * In development mode (NODE_ENV=development), uses pino-pretty for
 * human-readable colored output with timestamps. In production, outputs
 * JSON for log aggregation systems.
 *
 * The log level can be controlled via the LOG_LEVEL environment variable
 * (defaults to "info"). Valid levels: trace, debug, info, warn, error, fatal.
 *
 * @example
 * ```ts
 * import { logger } from "./logger.js";
 *
 * logger.info("Server started on port 7000");
 * logger.error("Failed to connect to Ollama", error);
 * logger.debug("Processing request", { requestId: "123" });
 * ```
 */

import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss Z",
            ignore: "pid,hostname",
          },
        }
      : undefined,
});
