/**
 * Unit tests — atomicWriteJson.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteJson } from "../../../../packages/server/src/utils/atomicWriteJson.js";

describe("atomicWriteJson", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes pretty JSON and creates parent directories", async () => {
    const dest = path.join(dir, "nested", "config.json");
    await atomicWriteJson(dest, { a: 1 }, "config");
    const raw = fs.readFileSync(dest, "utf8");
    expect(JSON.parse(raw)).toEqual({ a: 1 });
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("overwrites an existing file", async () => {
    const dest = path.join(dir, "x.json");
    await atomicWriteJson(dest, { v: 1 }, "x");
    await atomicWriteJson(dest, { v: 2 }, "x");
    expect(JSON.parse(fs.readFileSync(dest, "utf8"))).toEqual({ v: 2 });
  });
});
