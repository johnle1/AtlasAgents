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
      lmstudio: { baseUrl: "http://localhost:1234" },
    });
    expect(result).toEqual({ lmstudio: { baseUrl: "http://localhost:1234", hasApiKey: false } });
  });

  it("treats an empty-string apiKey as no key", () => {
    const result = stripProviderSecrets({
      lmstudio: { baseUrl: "http://localhost:1234", apiKey: "" },
    });
    expect(result.lmstudio?.hasApiKey).toBe(false);
  });

  it("preserves every provider name and baseUrl across multiple entries", () => {
    const result = stripProviderSecrets({
      openai: { baseUrl: "https://api.openai.com", apiKey: "sk-1" },
      customBackend: { baseUrl: "https://custom-backend.internal" },
    });
    expect(Object.keys(result).sort()).toEqual(["customBackend", "openai"]);
    expect(result.openai).toEqual({
      baseUrl: "https://api.openai.com",
      hasApiKey: true,
    });
    expect(result.customBackend).toEqual({
      baseUrl: "https://custom-backend.internal",
      hasApiKey: false,
    });
  });

  it("returns an empty object for an empty input", () => {
    expect(stripProviderSecrets({})).toEqual({});
  });
});
