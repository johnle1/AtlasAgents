/**
 * Unit tests — one-time copy of `~/.agent-cli` into `~/.atlasagents`.
 *
 * @remarks
 * `CONFIG_DIR` is computed from `os.homedir()` at module load, so
 * HOME/USERPROFILE are overridden (via {@link createTempHome}) before the
 * config module is imported. Isolated from other config tests because they
 * share one imported `CONFIG_DIR` per file.
 *
 * Category checklist:
 * - Happy path: leftover `.agent-cli` is copied into `.atlasagents`
 * - Contract: the legacy directory is left in place (copy, not move)
 * - State: a second call does not overwrite an existing `.atlasagents`
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempHome, type TempHome } from "../../../helpers/tempHome.js";

describe("config dir rename migration (~/.agent-cli → ~/.atlasagents)", () => {
  let tempHome: TempHome;
  let ensureDirs: typeof import("../../../../packages/client/src/config/index.js").ensureDirs;

  beforeAll(async () => {
    tempHome = createTempHome("atlas-config-migrate-");

    const legacyDir = path.join(tempHome.dir, ".agent-cli");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "marker.txt"), "from-legacy");
    fs.writeFileSync(
      path.join(legacyDir, "config.json"),
      JSON.stringify({ server: "legacy.example" }),
    );

    const configMod = await import(
      "../../../../packages/client/src/config/index.js"
    );
    ensureDirs = configMod.ensureDirs;
  });

  afterAll(() => {
    tempHome.restore();
  });

  it("copies ~/.agent-cli into ~/.atlasagents without deleting the original", () => {
    ensureDirs();

    const destMarker = path.join(tempHome.dir, ".atlasagents", "marker.txt");
    const srcMarker = path.join(tempHome.dir, ".agent-cli", "marker.txt");
    expect(fs.readFileSync(destMarker, "utf8")).toBe("from-legacy");
    expect(fs.readFileSync(srcMarker, "utf8")).toBe("from-legacy");
  });

  it("does not overwrite an existing ~/.atlasagents on a later call", () => {
    const destMarker = path.join(tempHome.dir, ".atlasagents", "marker.txt");
    fs.writeFileSync(destMarker, "already-new");
    fs.writeFileSync(
      path.join(tempHome.dir, ".agent-cli", "marker.txt"),
      "legacy-changed",
    );

    ensureDirs();

    expect(fs.readFileSync(destMarker, "utf8")).toBe("already-new");
  });
});
