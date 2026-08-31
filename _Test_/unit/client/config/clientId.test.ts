/**
 * Unit tests — client config/clientId.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockReadFileSync, mockWriteFileSync, mockEnsureDirs, mockRandomUUID } =
  vi.hoisted(() => ({
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockEnsureDirs: vi.fn(),
    mockRandomUUID: vi.fn(),
  }));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  },
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
}));

vi.mock("node:crypto", () => ({
  randomUUID: mockRandomUUID,
}));

vi.mock("../../../../packages/client/src/config/index.js", () => ({
  CONFIG_DIR: "/fake-home/.atlasagents",
  ensureDirs: mockEnsureDirs,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("getClientId", () => {
  it("returns the existing persisted id without generating a new one (normal)", async () => {
    mockReadFileSync.mockReturnValue("existing-id-123\n");
    const { getClientId } = await import(
      "../../../../packages/client/src/config/clientId.js"
    );

    expect(getClientId()).toBe("existing-id-123");
    expect(mockRandomUUID).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("generates and persists a new id when no file exists yet (boundary)", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockRandomUUID.mockReturnValue("generated-id-456");
    const { getClientId } = await import(
      "../../../../packages/client/src/config/clientId.js"
    );

    expect(getClientId()).toBe("generated-id-456");
    expect(mockEnsureDirs).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      "/fake-home/.atlasagents/clientId",
      "generated-id-456",
      { encoding: "utf-8" },
    );
  });

  it("generates a new id when the file is present but empty (boundary)", async () => {
    mockReadFileSync.mockReturnValue("   ");
    mockRandomUUID.mockReturnValue("generated-id-789");
    const { getClientId } = await import(
      "../../../../packages/client/src/config/clientId.js"
    );

    expect(getClientId()).toBe("generated-id-789");
  });

  it("caches the id in-process — only reads disk once across repeated calls (normal)", async () => {
    mockReadFileSync.mockReturnValue("existing-id-123");
    const { getClientId } = await import(
      "../../../../packages/client/src/config/clientId.js"
    );

    getClientId();
    getClientId();
    getClientId();

    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });
});
