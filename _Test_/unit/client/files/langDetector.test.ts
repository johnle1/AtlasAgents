/**
 * Unit tests — packages/client/src/diff/langDetector.ts
 */

import { describe, expect, it } from "vitest";
import { detectLang } from "../../../../packages/client/src/diff/langDetector.js";

describe("detectLang", () => {
  it("maps common extensions", () => {
    expect(detectLang("packages/client/src/app.tsx")).toBe("tsx");
    expect(detectLang("script.js")).toBe("javascript");
    expect(detectLang("README.md")).toBe("markdown");
    expect(detectLang("data.json")).toBe("json");
  });

  it("handles Dockerfile variants", () => {
    expect(detectLang("Dockerfile")).toBe("dockerfile");
    expect(detectLang("dockerfile.prod")).toBe("dockerfile");
    expect(detectLang("path/to/Dockerfile.dev")).toBe("dockerfile");
  });

  it("treats .d.ts as typescript", () => {
    expect(detectLang("types/index.d.ts")).toBe("typescript");
  });

  it("accepts Windows path separators", () => {
    expect(detectLang("src\\Button.tsx")).toBe("tsx");
  });

  it("falls back to text for unknown extensions", () => {
    expect(detectLang("notes.txt")).toBe("text");
    expect(detectLang("noextension")).toBe("text");
  });
});
