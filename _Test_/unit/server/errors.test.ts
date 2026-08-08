/**
 * Unit tests — server AppError hierarchy.
 */

import { describe, expect, it } from "vitest";
import { AbortError } from "../../../packages/server/src/errors/abortError.js";
import { AppError } from "../../../packages/server/src/errors/appError.js";
import { ConflictError } from "../../../packages/server/src/errors/conflictError.js";
import { NotFoundError } from "../../../packages/server/src/errors/notFoundError.js";
import { OrchestrationError } from "../../../packages/server/src/errors/orchestrationError.js";
import { TimeoutError } from "../../../packages/server/src/errors/timeoutError.js";
import { UnauthorizedError } from "../../../packages/server/src/errors/unauthorizedError.js";
import { ConfigurationError } from "../../../packages/server/src/errors/configurationError.js";
import { ValidationError } from "../../../packages/server/src/errors/validationError.js";
import { AdminUnsupportedError, ModelProviderError } from "../../../packages/server/src/providers/errors.js";

describe("AppError", () => {
  it("stores message, statusCode, and code", () => {
    const err = new AppError("oops", 400, "BAD");
    expect(err).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(err).constructor.name).toBe("AppError");
    expect(err.message).toBe("oops");
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("BAD");
    expect(err.name).toBe("AppError");
  });
});

describe("AbortError", () => {
  it("defaults to 499 / ABORTED", () => {
    const err = new AbortError();
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe("Operation aborted");
    expect(err.statusCode).toBe(499);
    expect(err.code).toBe("ABORTED");
  });

  it("accepts a custom message", () => {
    expect(new AbortError("cancelled").message).toBe("cancelled");
  });
});

describe("ConflictError", () => {
  it("is an AppError with conflict semantics", () => {
    const err = new ConflictError("taken");
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe("taken");
    expect(err.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("NotFoundError", () => {
  it("is an AppError with a 'not found' message", () => {
    const err = new NotFoundError("missing");
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe("missing not found");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("OrchestrationError", () => {
  it("is an AppError", () => {
    const err = new OrchestrationError("plan failed");
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe("plan failed");
  });
});

describe("TimeoutError", () => {
  it("is an AppError", () => {
    const err = new TimeoutError("slow");
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe("slow");
  });
});

describe("UnauthorizedError", () => {
  it("is an AppError", () => {
    const err = new UnauthorizedError("nope");
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe("nope");
  });
});

describe("ConfigurationError", () => {
  it("extends AppError via super", () => {
    const err = new ConfigurationError("bad config");
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe("bad config");
  });
});

describe("ValidationError", () => {
  it("extends AppError via super", () => {
    const err = new ValidationError("invalid");
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe("invalid");
  });
});

describe("ModelProviderError", () => {
  it("extends Error via super", () => {
    const err = new ModelProviderError(502, "upstream");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(502);
  });
});

describe("AdminUnsupportedError", () => {
  it("extends Error via super", () => {
    const err = new AdminUnsupportedError("nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("nope");
  });
});
