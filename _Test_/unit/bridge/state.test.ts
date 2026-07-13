/**
 * Unit tests — bridge/state.ts
 *
 * Tests every get/set accessor pair exported from the global bridge state
 * singleton. The bridge state is a module-level singleton (not a class),
 * so tests reset it in `beforeEach` using the set functions themselves.
 *
 * Testing pyramid layer : Unit
 * Runner                 : Vitest
 * Mocks                  : none — bridge/state.ts has no runtime side effects;
 *   its only external import is a type from config.ts.
 *
 * State reset strategy
 * --------------------
 * Because the module's state persists across tests in the same process, each
 * test group starts with a `beforeEach` that restores every field to its
 * documented initial value. This keeps tests independent regardless of order.
 *
 * Category checklist:
 *   ✅ Normal  — typical set/get round-trips
 *   ✅ Boundary — null entries, empty hook objects, boolean toggles
 *   ✅ Error   — setting null clears the field without throwing
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeHooks } from "../../../packages/client/src/ui/bridge/state";
import {
  getBridgeHooks,
  getInkUIActive,
  getPendingApprovalEntry,
  getPendingPromptEntry,
  getStreamingTokenHandler,
  getTaskActiveValue,
  setBridgeHooks,
  setInkUIActiveValue,
  setPendingApprovalEntry,
  setPendingPromptEntry,
  setStreamingTokenHandler,
  setTaskActiveValue,
} from "../../../packages/client/src/ui/bridge/state";

// ---------------------------------------------------------------------------
// Reset the singleton state before each test so tests are fully isolated.
// ---------------------------------------------------------------------------
beforeEach(() => {
  setBridgeHooks({});
  setInkUIActiveValue(false);
  setTaskActiveValue(false);
  setPendingApprovalEntry(null);
  setPendingPromptEntry(null);
  setStreamingTokenHandler(null);
});

// ---------------------------------------------------------------------------
// getBridgeHooks / setBridgeHooks
// ---------------------------------------------------------------------------

describe("getBridgeHooks / setBridgeHooks", () => {
  it("returns an empty object as the initial hooks state (boundary — default)", () => {
    // After reset, hooks should be an empty object (not null or undefined)
    const hooks = getBridgeHooks();
    expect(hooks).toEqual({});
  });

  it("stores and retrieves a hooks object with callbacks (normal)", () => {
    const onSpinner = vi.fn();
    const hooks: BridgeHooks = { onSpinner };
    setBridgeHooks(hooks);
    // The getter must return the exact same reference
    expect(getBridgeHooks()).toBe(hooks);
    expect(getBridgeHooks().onSpinner).toBe(onSpinner);
  });

  it("replaces the existing hooks object when called twice (normal)", () => {
    const firstHooks: BridgeHooks = { onBusy: vi.fn() };
    const secondHooks: BridgeHooks = { onTaskActive: vi.fn() };
    setBridgeHooks(firstHooks);
    setBridgeHooks(secondHooks);
    expect(getBridgeHooks()).toBe(secondHooks);
  });

  it("accepts an empty object as a valid hooks value (boundary — clear all hooks)", () => {
    setBridgeHooks({ onBusy: vi.fn() }); // set something first
    setBridgeHooks({}); // then clear
    expect(getBridgeHooks()).toEqual({});
  });

  it("registered callbacks are invocable after retrieval (normal)", () => {
    const onCwd = vi.fn();
    setBridgeHooks({ onCwd });
    // Calling the hook through the getter should invoke the mock
    getBridgeHooks().onCwd?.("/home/user/project");
    expect(onCwd).toHaveBeenCalledWith("/home/user/project");
  });
});

// ---------------------------------------------------------------------------
// getInkUIActive / setInkUIActiveValue
// ---------------------------------------------------------------------------

describe("getInkUIActive / setInkUIActiveValue", () => {
  it("defaults to false (boundary — initial state)", () => {
    expect(getInkUIActive()).toBe(false);
  });

  it("returns true after being set to true (normal)", () => {
    setInkUIActiveValue(true);
    expect(getInkUIActive()).toBe(true);
  });

  it("returns false after being toggled back to false (normal)", () => {
    setInkUIActiveValue(true);
    setInkUIActiveValue(false);
    expect(getInkUIActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getTaskActiveValue / setTaskActiveValue
// ---------------------------------------------------------------------------

describe("getTaskActiveValue / setTaskActiveValue", () => {
  it("defaults to false (boundary — initial state)", () => {
    expect(getTaskActiveValue()).toBe(false);
  });

  it("returns true after setting to true (normal)", () => {
    setTaskActiveValue(true);
    expect(getTaskActiveValue()).toBe(true);
  });

  it("returns false after toggling back (normal)", () => {
    setTaskActiveValue(true);
    setTaskActiveValue(false);
    expect(getTaskActiveValue()).toBe(false);
  });

  it("is independent of inkUIActive state (boundary — orthogonal flags)", () => {
    // The two flags must not bleed into each other
    setInkUIActiveValue(true);
    setTaskActiveValue(false);
    expect(getInkUIActive()).toBe(true);
    expect(getTaskActiveValue()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPendingApprovalEntry / setPendingApprovalEntry
// ---------------------------------------------------------------------------

describe("getPendingApprovalEntry / setPendingApprovalEntry", () => {
  it("defaults to null (boundary — no pending approval)", () => {
    expect(getPendingApprovalEntry()).toBeNull();
  });

  it("stores a PendingApproval entry and returns it (normal)", () => {
    const resolve = vi.fn();
    const entry = {
      req: { type: "runSkip" as const, command: "npm install" },
      resolve,
    };
    setPendingApprovalEntry(entry);
    const retrieved = getPendingApprovalEntry();
    expect(retrieved).toBe(entry);
    expect(retrieved!.req).toEqual({ type: "runSkip", command: "npm install" });
  });

  it("stored resolve function is callable (normal)", () => {
    const resolve = vi.fn();
    const entry = {
      req: { type: "keepUndo" as const, contextLabel: "src/App.tsx" },
      resolve,
    };
    setPendingApprovalEntry(entry);
    // Simulate user approving → call the resolver
    getPendingApprovalEntry()!.resolve(true);
    expect(resolve).toHaveBeenCalledWith(true);
  });

  it("clears the entry when set to null (normal — approval resolved)", () => {
    const entry = {
      req: { type: "keepUndo" as const, contextLabel: "file.ts" },
      resolve: vi.fn(),
    };
    setPendingApprovalEntry(entry);
    setPendingApprovalEntry(null);
    expect(getPendingApprovalEntry()).toBeNull();
  });

  it("replaces an existing entry with a new one (boundary — double set)", () => {
    const firstEntry = {
      req: { type: "keepUndo" as const, contextLabel: "first.ts" },
      resolve: vi.fn(),
    };
    const secondEntry = {
      req: { type: "runSkip" as const, command: "rm -rf dist" },
      resolve: vi.fn(),
    };
    setPendingApprovalEntry(firstEntry);
    setPendingApprovalEntry(secondEntry);
    expect(getPendingApprovalEntry()).toBe(secondEntry);
  });
});

// ---------------------------------------------------------------------------
// getPendingPromptEntry / setPendingPromptEntry
// ---------------------------------------------------------------------------

describe("getPendingPromptEntry / setPendingPromptEntry", () => {
  it("defaults to null (boundary — no pending prompt)", () => {
    expect(getPendingPromptEntry()).toBeNull();
  });

  it("stores a line-type prompt entry and returns it (normal)", () => {
    const resolve = vi.fn();
    const entry = {
      req: { type: "line" as const, prompt: "Enter your name:" },
      resolve,
    };
    setPendingPromptEntry(entry);
    expect(getPendingPromptEntry()).toBe(entry);
  });

  it("stores a choice-type prompt entry (normal)", () => {
    const entry = {
      req: { type: "choice" as const, prompt: "Select a model:", max: 3 },
      resolve: vi.fn(),
    };
    setPendingPromptEntry(entry);
    expect(getPendingPromptEntry()!.req.type).toBe("choice");
  });

  it("stored resolve is callable and receives the user response (normal)", () => {
    const resolve = vi.fn();
    setPendingPromptEntry({
      req: { type: "line" as const, prompt: "Name?" },
      resolve,
    });
    getPendingPromptEntry()!.resolve("Ada Lovelace");
    expect(resolve).toHaveBeenCalledWith("Ada Lovelace");
  });

  it("clears the prompt when set to null (normal — prompt resolved)", () => {
    setPendingPromptEntry({
      req: { type: "line" as const, prompt: "Enter value:" },
      resolve: vi.fn(),
    });
    setPendingPromptEntry(null);
    expect(getPendingPromptEntry()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getStreamingTokenHandler / setStreamingTokenHandler
// ---------------------------------------------------------------------------

describe("getStreamingTokenHandler / setStreamingTokenHandler", () => {
  it("defaults to null (boundary — no handler registered)", () => {
    expect(getStreamingTokenHandler()).toBeNull();
  });

  it("stores a handler function and returns it (normal)", () => {
    const handler = vi.fn();
    setStreamingTokenHandler(handler);
    expect(getStreamingTokenHandler()).toBe(handler);
  });

  it("stored handler is invocable with a token string (normal)", () => {
    const tokens: string[] = [];
    const handler = (token: string) => tokens.push(token);
    setStreamingTokenHandler(handler);
    // Simulate three tokens arriving from the stream
    getStreamingTokenHandler()!("Hello");
    getStreamingTokenHandler()!(" ");
    getStreamingTokenHandler()!("World");
    expect(tokens).toEqual(["Hello", " ", "World"]);
  });

  it("clears the handler when set to null (normal — stream ended)", () => {
    setStreamingTokenHandler(vi.fn());
    setStreamingTokenHandler(null);
    expect(getStreamingTokenHandler()).toBeNull();
  });

  it("replaces an existing handler with a new one (boundary — handler swap)", () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();
    setStreamingTokenHandler(firstHandler);
    setStreamingTokenHandler(secondHandler);
    expect(getStreamingTokenHandler()).toBe(secondHandler);
    expect(getStreamingTokenHandler()).not.toBe(firstHandler);
  });
});
