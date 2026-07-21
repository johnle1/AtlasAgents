/**
 * Unit tests — server providers/singleModelAdmin.ts
 *
 * vLLM/Trainium/TPU have no pull/delete/swap semantics — the model is fixed
 * at launch. These tests confirm listing works against GET /models and that
 * pull/delete surface a clear AdminUnsupportedError instead of failing silently.
 */

import { describe, expect, it } from "vitest";
import { SingleModelAdmin } from "../../packages/server/src/providers/singleModelAdmin.js";
import { AdminUnsupportedError, ModelProviderError } from "../../packages/server/src/providers/errors.js";

type FakeResponseInit = {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

const fakeFetch = (init: FakeResponseInit): typeof fetch =>
  (async () =>
    ({
      ok: init.ok,
      status: init.status,
      json: init.json ?? (async () => ({})),
      text: init.text ?? (async () => ""),
    }) as unknown as Response) as unknown as typeof fetch;

describe("SingleModelAdmin.listModelsDetailed / listModels", () => {
  it("maps GET /models data.id entries to model summaries", async () => {
    const admin = new SingleModelAdmin("http://x/v1", "key", {
      fetch: fakeFetch({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "qwen2.5-7b" }, { id: "llama3.1" }] }),
      }),
    });

    expect(await admin.listModelsDetailed()).toEqual([
      { name: "qwen2.5-7b" },
      { name: "llama3.1" },
    ]);
    expect(await admin.listModels()).toEqual(["qwen2.5-7b", "llama3.1"]);
  });

  it("drops entries with missing or empty ids", async () => {
    const admin = new SingleModelAdmin("http://x/v1", "key", {
      fetch: fakeFetch({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "" }, {}, { id: "ok-model" }] }),
      }),
    });

    expect(await admin.listModels()).toEqual(["ok-model"]);
  });

  it("throws ModelProviderError on non-2xx", async () => {
    const admin = new SingleModelAdmin("http://x/v1", "key", {
      fetch: fakeFetch({ ok: false, status: 503, text: async () => "down" }),
    });

    await expect(admin.listModels()).rejects.toThrow(ModelProviderError);
  });
});

describe("SingleModelAdmin.showModel", () => {
  it("reports native tool-calling capability for any model name", async () => {
    const admin = new SingleModelAdmin("http://x/v1", "key");
    const info = await admin.showModel("qwen2.5-7b");
    expect(info).toEqual({ name: "qwen2.5-7b", capabilities: ["tools"] });
  });
});

describe("SingleModelAdmin.listRunning", () => {
  it("reports the single launched model as running", async () => {
    const admin = new SingleModelAdmin("http://x/v1", "key", {
      fetch: fakeFetch({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "qwen2.5-7b" }] }),
      }),
    });

    expect(await admin.listRunning()).toEqual([
      { name: "qwen2.5-7b", size: 0 },
    ]);
  });
});

describe("SingleModelAdmin pull/delete — unsupported", () => {
  it("pullModel throws AdminUnsupportedError before yielding anything", async () => {
    const admin = new SingleModelAdmin("http://x/v1", "key");

    await expect(async () => {
      for await (const _progress of admin.pullModel("some-model")) {
        // never reached
      }
    }).rejects.toThrow(AdminUnsupportedError);
  });

  it("deleteModel throws AdminUnsupportedError", async () => {
    const admin = new SingleModelAdmin("http://x/v1", "key");
    await expect(admin.deleteModel("some-model")).rejects.toThrow(
      AdminUnsupportedError,
    );
  });
});
