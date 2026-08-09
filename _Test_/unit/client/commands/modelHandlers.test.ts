/**
 * Unit tests — client commands/modelHandlers.ts, focused on the two new
 * pieces of `/models`: `storage` and `delete`'s `freedBytes` display.
 *
 * `../renderer.js` is mocked so assertions can check exactly what text
 * reached the user, rather than re-deriving it from ANSI-styled lines —
 * `printModelStorage`/`formatStorageBytes` themselves are already covered
 * by rendererModelOutput.test.ts.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleModels } from "../../../../packages/client/src/commands/modelHandlers.js";
import type { Connection } from "../../../../packages/client/src/connection/index.js";
import type { ModelStorageReport } from "@loopycode/shared";

const printSuccess = vi.fn();
const printError = vi.fn();
const printLine = vi.fn();
const printModelStorage = vi.fn();
const formatStorageBytes = vi.fn((bytes: number) =>
  bytes === 0 ? "0 B" : `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`,
);

vi.mock("../../../../packages/client/src/renderer.js", () => ({
  printInstalledModels: vi.fn(),
  printModelFind: vi.fn(),
  printModelStorage: (...args: unknown[]) => printModelStorage(...args),
  formatStorageBytes: (...args: [number]) => formatStorageBytes(...args),
  printLine: (...args: unknown[]) => printLine(...args),
  printError: (...args: unknown[]) => printError(...args),
  printSuccess: (...args: unknown[]) => printSuccess(...args),
  printProgress: vi.fn(),
  resetPullProgress: vi.fn(),
  finishPullProgress: vi.fn(),
}));

beforeEach(() => {
  printSuccess.mockClear();
  printError.mockClear();
  printLine.mockClear();
  printModelStorage.mockClear();
  formatStorageBytes.mockClear();
});

const fakeConn = (sendCommand: Connection["sendCommand"]): Connection =>
  ({ sendCommand }) as unknown as Connection;

describe("handleModels — storage", () => {
  it("sends models.storage with no payload and forwards the report to printModelStorage", async () => {
    const report: ModelStorageReport = {
      available: true,
      dir: "/home/user/.ollama/models",
      dirSource: "default:~/.ollama/models",
      models: [],
      orphans: [],
      totals: { onDiskBytes: 0, referencedBytes: 0, orphanedBytes: 0 },
    };
    const sendCommand = vi.fn(async () => report);

    await handleModels("storage", "", fakeConn(sendCommand));

    expect(sendCommand).toHaveBeenCalledWith("models.storage", {});
    expect(printModelStorage).toHaveBeenCalledWith(report);
  });

  it("prints an error rather than throwing when the server call fails", async () => {
    const sendCommand = vi.fn(async () => {
      throw new Error("connection refused");
    });

    await expect(
      handleModels("storage", "", fakeConn(sendCommand)),
    ).resolves.toBeUndefined();
    expect(printError).toHaveBeenCalled();
    expect(printModelStorage).not.toHaveBeenCalled();
  });
});

describe("handleModels — delete freedBytes display", () => {
  it("includes the freed amount in the success message when freedBytes is a number", async () => {
    const sendCommand = vi.fn(async () => ({
      ok: true,
      wasAgentModel: false,
      wasSubagentModel: false,
      freedBytes: 0,
    }));

    await handleModels("delete", "gemma3:latest", fakeConn(sendCommand));

    expect(sendCommand).toHaveBeenCalledWith("models.delete", {
      name: "gemma3:latest",
    });
    expect(formatStorageBytes).toHaveBeenCalledWith(0);
    expect(printSuccess).toHaveBeenCalledWith(
      expect.stringContaining("freed 0 B"),
    );
  });

  it("omits the freed amount when freedBytes is undefined (storage scan unavailable)", async () => {
    const sendCommand = vi.fn(async () => ({
      ok: true,
      wasAgentModel: false,
      wasSubagentModel: false,
    }));

    await handleModels("delete", "gemma3:latest", fakeConn(sendCommand));

    expect(formatStorageBytes).not.toHaveBeenCalled();
    expect(printSuccess).toHaveBeenCalledWith("Deleted gemma3:latest");
  });

  it("still warns about an active role model alongside the freed-bytes message", async () => {
    const sendCommand = vi.fn(async () => ({
      ok: true,
      wasAgentModel: true,
      wasSubagentModel: false,
      freedBytes: 5_000_000_000,
    }));

    await handleModels("delete", "gemma3:12b", fakeConn(sendCommand));

    expect(printSuccess).toHaveBeenCalledWith(expect.stringContaining("freed"));
    expect(printLine).toHaveBeenCalledWith(expect.stringContaining("active agent model"));
  });
});
