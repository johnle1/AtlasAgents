/**
 * Unit tests — packages/shared/src/protocol/serverProtocol.ts
 */

import { describe, expect, it } from "vitest";
import {
  ROUTE_IDS,
  STREAM_KINDS,
  isRouteId,
  isStreamKind,
} from "../../../packages/shared/src/protocol/serverProtocol.js";

describe("isRouteId", () => {
  it("accepts every known ROUTE_IDS entry", () => {
    for (const route of ROUTE_IDS) {
      expect(isRouteId(route)).toBe(true);
    }
  });

  it("rejects unknown and empty strings", () => {
    expect(isRouteId("models.unknown")).toBe(false);
    expect(isRouteId("task")).toBe(false);
    expect(isRouteId("")).toBe(false);
  });

  it("narrows type at compile time when true", () => {
    const raw = "config.get";
    if (isRouteId(raw)) {
      expect(raw).toBe("config.get");
    }
  });
});

describe("isStreamKind", () => {
  it("accepts every known STREAM_KINDS entry", () => {
    for (const kind of STREAM_KINDS) {
      expect(isStreamKind(kind)).toBe(true);
    }
  });

  it("rejects command routes and garbage", () => {
    expect(isStreamKind("models.list")).toBe(false);
    expect(isStreamKind("")).toBe(false);
    expect(isStreamKind("tasks")).toBe(false);
  });
});
