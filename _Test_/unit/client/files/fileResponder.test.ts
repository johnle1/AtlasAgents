/**
 * Unit tests — connection/fileResponder.ts
 */

import { describe, expect, it, vi } from "vitest";
import { createFileResponder } from "../../../../packages/client/src/connection/fileResponder.js";

describe("createFileResponder", () => {
  it("returns not-initialized error when proxy is null", async () => {
    const onNext = vi.fn();
    const { requestResponse } = createFileResponder(null);
    requestResponse({ data: Buffer.from("{}") }, { onNext });

    await vi.waitFor(() => expect(onNext).toHaveBeenCalled());
    const body = JSON.parse(onNext.mock.calls[0]![0].data!.toString("utf8"));
    expect(body).toEqual({ ok: false, error: "File proxy not initialized" });
  });

  it("delegates to fileProxy.handle and returns JSON result", async () => {
    const handle = vi.fn().mockResolvedValue({ ok: true, data: { x: 1 } });
    const proxy = { handle } as never;
    const onNext = vi.fn();
    const { requestResponse } = createFileResponder(proxy);

    requestResponse(
      {
        data: Buffer.from(
          JSON.stringify({ route: "file.get_cwd", payload: {} }),
        ),
      },
      { onNext },
    );

    await vi.waitFor(() => expect(onNext).toHaveBeenCalled());
    expect(handle).toHaveBeenCalledWith("file.get_cwd", {});
    const body = JSON.parse(onNext.mock.calls[0]![0].data!.toString("utf8"));
    expect(body).toEqual({ ok: true, data: { x: 1 } });
  });

  it("returns structured error when handle throws", async () => {
    const handle = vi.fn().mockRejectedValue(new Error("boom"));
    const onNext = vi.fn();
    const { requestResponse } = createFileResponder({ handle } as never);
    requestResponse({ data: Buffer.from('{"route":"file.read"}') }, { onNext });

    await vi.waitFor(() => expect(onNext).toHaveBeenCalled());
    const body = JSON.parse(onNext.mock.calls[0]![0].data!.toString("utf8"));
    expect(body).toEqual({ ok: false, error: "boom" });
  });
});
