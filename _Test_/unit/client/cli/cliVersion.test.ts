/**
 * Unit tests — packages/client/src/renderer/version.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "../../../../packages/client/src/renderer/version.js";

const clientPackage = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../../packages/client/package.json"),
    "utf8",
  ),
) as { version: string };

describe("CLI_VERSION", () => {
  it("matches packages/client/package.json version", () => {
    expect(CLI_VERSION).toBe(clientPackage.version);
  });

  it("is a non-empty semver-like string", () => {
    expect(CLI_VERSION.length).toBeGreaterThan(0);
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
