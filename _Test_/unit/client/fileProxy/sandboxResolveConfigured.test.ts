/**
 * Unit tests — resolveConfiguredSandbox (config-keyed sandbox resolution/caching).
 *
 * @remarks
 * Mocks `capability.ts` to spy on how many times the underlying (real)
 * capability probe actually runs — the point of this cache is to avoid
 * spawning `which`/`where` once per shell command.
 *
 * Category checklist:
 * - Normal: default config (auto + default image) resolves without a probe
 *   (delegates to the already-memoized bare resolveSandbox() path)
 * - Boundary: a customized config (e.g. "container" mode) is memoized per
 *   distinct (mode, image) pair, re-probing only when that pair changes or
 *   the cache is reset
 * - Error: a customized config still does REAL probing, not the
 *   deterministic-unavailable defaults tests rely on (regression guard for
 *   a bug where passing any options object suppressed real probing)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDetectContainerRuntime } = vi.hoisted(() => ({
  mockDetectContainerRuntime: vi.fn<() => "docker" | "podman" | null>(
    () => "docker",
  ),
}));

vi.mock("../../../../packages/client/src/fileProxy/sandbox/capability.js", () => ({
  isBinaryOnPath: () => false,
  detectContainerRuntime: mockDetectContainerRuntime,
}));

import {
  resetSandboxCache,
  resolveConfiguredSandbox,
} from "../../../../packages/client/src/fileProxy/sandbox/index.js";
import { DEFAULT_SANDBOX_IMAGE } from "../../../../packages/client/src/fileProxy/sandbox/container/docker.js";

beforeEach(() => {
  mockDetectContainerRuntime.mockClear();
  resetSandboxCache();
});

afterEach(() => {
  resetSandboxCache();
});

describe("resolveConfiguredSandbox — customized config actually probes", () => {
  it("does real capability probing for a non-default mode, not the test-deterministic defaults (error — regression guard)", () => {
    const provider = resolveConfiguredSandbox("container", DEFAULT_SANDBOX_IMAGE);
    // Before the fix, passing an options object at all suppressed real
    // probing, so this always came back null regardless of what's installed.
    expect(mockDetectContainerRuntime).toHaveBeenCalled();
    expect(provider?.id).toBe("container-docker");
  });

  it("memoizes per (mode, image) pair — a second call with the same pair does not re-probe (boundary)", () => {
    resolveConfiguredSandbox("container", DEFAULT_SANDBOX_IMAGE);
    resolveConfiguredSandbox("container", DEFAULT_SANDBOX_IMAGE);
    expect(mockDetectContainerRuntime).toHaveBeenCalledTimes(1);
  });

  it("re-probes when the containerImage changes (boundary)", () => {
    resolveConfiguredSandbox("container", DEFAULT_SANDBOX_IMAGE);
    resolveConfiguredSandbox("container", "my-org/custom:latest");
    expect(mockDetectContainerRuntime).toHaveBeenCalledTimes(2);
  });

  it("re-probes after resetSandboxCache (normal — /sandbox <mode> takes effect immediately)", () => {
    resolveConfiguredSandbox("container", DEFAULT_SANDBOX_IMAGE);
    resetSandboxCache();
    resolveConfiguredSandbox("container", DEFAULT_SANDBOX_IMAGE);
    expect(mockDetectContainerRuntime).toHaveBeenCalledTimes(2);
  });
});
