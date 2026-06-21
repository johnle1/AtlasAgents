/**
 * <Summary>
 * What it does:
 *   Centralized logger instance using pino for structured logging.
 *
 * How it fits in the system:
 *   Provides a consistent logging interface throughout the application.
 *   Replaces console.log calls with structured logging.
 *
 * Dependencies:
 *   - pino - structured logging library.
 *
 * Dependants:
 *   - All application modules that need logging.
 * </Summary>
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
