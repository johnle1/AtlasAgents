/**
 * Unit tests — ui/bridge/hooks.ts (re-exported via uiBridge)
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  getBridgeHooks,
  setBridgeHooks,
  setInkUIActiveValue,
} from "../../../../packages/client/src/ui/bridge/state.js";
import {
  isInkActive,
  registerBridgeHooks,
  setInkActive,
} from "../../../../packages/client/src/ui/bridge/hooks.js";

beforeEach(() => {
  setBridgeHooks({});
  setInkUIActiveValue(false);
});

describe("bridge hooks", () => {
  it("setInkActive / isInkActive track Ink UI flag", () => {
    expect(isInkActive()).toBe(false);
    setInkActive(true);
    expect(isInkActive()).toBe(true);
  });

  it("registerBridgeHooks replaces bridge hook table", () => {
    const hooks = { onBusy: () => {} };
    registerBridgeHooks(hooks);
    expect(getBridgeHooks()).toBe(hooks);
  });
});
