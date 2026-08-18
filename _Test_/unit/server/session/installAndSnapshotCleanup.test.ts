/**
 * Unit tests — setup/installUserDataDefaults.ts and workspace cleanup
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installUserDataDefaults } from "../../../../packages/server/src/setup/installUserDataDefaults.js";
import { cleanupOldSnapshots } from "../../../../packages/server/src/workspace/cleanup/snapshotCleanup.js";
import { LANGUAGE_HINTS_FILENAME } from "../../../../packages/server/src/memory/context/languageHints.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("installUserDataDefaults", () => {
  it("does not overwrite an existing language-hints file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-install-"));
    tempRoots.push(root);
    const userData = path.join(root, "user-data");
    await fs.mkdir(userData, { recursive: true });
    const dest = path.join(userData, LANGUAGE_HINTS_FILENAME);
    await fs.writeFile(dest, '{"custom": true}', "utf-8");

    await installUserDataDefaults(root);

    const content = await fs.readFile(dest, "utf-8");
    expect(content).toBe('{"custom": true}');
  });

  it("is a no-op when source default is missing and destination absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-install-"));
    tempRoots.push(root);
    await installUserDataDefaults(root);
    const dest = path.join(root, "user-data", LANGUAGE_HINTS_FILENAME);
    await expect(fs.access(dest)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("cleanupOldSnapshots", () => {
  it("returns 0 when snapshots directory is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-snap-"));
    tempRoots.push(root);
    await expect(cleanupOldSnapshots(root)).resolves.toBe(0);
  });

  it("deletes snapshot files older than 24 hours", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-snap-"));
    tempRoots.push(root);
    const dir = path.join(root, "user-data", "snapshots");
    await fs.mkdir(dir, { recursive: true });
    const oldTs = Date.now() - 25 * 60 * 60 * 1000;
    const recentTs = Date.now();
    await fs.writeFile(path.join(dir, `${oldTs}-old.json`), "{}", "utf-8");
    await fs.writeFile(path.join(dir, `${recentTs}-new.json`), "{}", "utf-8");

    const removed = await cleanupOldSnapshots(root);
    expect(removed).toBe(1);
    await expect(fs.access(path.join(dir, `${oldTs}-old.json`))).rejects.toThrow();
    await expect(fs.access(path.join(dir, `${recentTs}-new.json`))).resolves.toBeUndefined();
  });
});
