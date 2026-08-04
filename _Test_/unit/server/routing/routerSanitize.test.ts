/**
 * Unit tests — stripProviderSecrets, which keeps provider API keys out of
 * the providers.list / config.get responses sent to clients.
 */

import { describe, expect, it } from "vitest";
import { stripProviderSecrets } from "../../../../packages/server/src/routing/routerBuilder.js";

describe("stripProviderSecrets", () => {
  it("drops apiKey and reports hasApiKey: true when a key is set", () => {
    const result = stripProviderSecrets({
      openai: { baseUrl: "https://api.openai.com", apiKey: "sk-secret" },
    });
    expect(result).toEqual({
      openai: { baseUrl: "https://api.openai.com", hasApiKey: true },
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("reports hasApiKey: false when no key is set", () => {
    const result = stripProviderSecrets({
      vllm: { baseUrl: "http://localhost:8000" },
    });
    expect(result).toEqual({ vllm: { baseUrl: "http://localhost:8000", hasApiKey: false } });
  });

  it("treats an empty-string apiKey as no key", () => {
    const result = stripProviderSecrets({
      vllm: { baseUrl: "http://localhost:8000", apiKey: "" },
    });
    expect(result.vllm?.hasApiKey).toBe(false);
  });

  it("preserves every provider name and baseUrl across multiple entries", () => {
    const result = stripProviderSecrets({
      openai: { baseUrl: "https://api.openai.com", apiKey: "sk-1" },
      trainium: { baseUrl: "https://trainium.internal" },
    });
    expect(Object.keys(result).sort()).toEqual(["openai", "trainium"]);
    expect(result.openai).toEqual({
      baseUrl: "https://api.openai.com",
      hasApiKey: true,
    });
    expect(result.trainium).toEqual({
      baseUrl: "https://trainium.internal",
      hasApiKey: false,
    });
  });

  it("returns an empty object for an empty input", () => {
    expect(stripProviderSecrets({})).toEqual({});
  });
});
