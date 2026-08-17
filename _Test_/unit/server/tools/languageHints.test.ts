/**
 * Unit tests — server memory/context/languageHints.ts
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  LANGUAGE_HINTS_FILENAME,
  loadLanguageHints,
  parseLanguageHints,
} from "../../../../packages/server/src/memory/context/languageHints.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("parseLanguageHints", () => {
  it("normalises valid rows and drops invalid ones", () => {
    const hints = parseLanguageHints([
      { needle: " TypeScript ", tag: "TypeScript" },
      { needle: "react", tag: "React" },
      { needle: "", tag: "bad" },
      { needle: "go", tag: "" },
      null,
      "not-an-object",
    ]);
    expect(hints).toEqual([
      { needle: "TypeScript", tag: "typescript" },
      { needle: "react", tag: "react" },
    ]);
  });

  it("returns an empty array when input is not an array", () => {
    expect(parseLanguageHints({})).toEqual([]);
    expect(parseLanguageHints(null)).toEqual([]);
  });
});

describe("loadLanguageHints", () => {
  const writeHintsFile = async (
    root: string,
    contents: string,
  ): Promise<string> => {
    const dir = path.join(root, "user-data");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, LANGUAGE_HINTS_FILENAME);
    await fs.writeFile(filePath, contents, "utf-8");
    return root;
  };

  it("loads and parses hints from user-data/language-hints.json", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-lang-hints-"));
    tempRoots.push(root);
    await writeHintsFile(
      root,
      JSON.stringify([{ needle: "python", tag: "Python" }]),
    );

    const hints = await loadLanguageHints(root);
    expect(hints).toEqual([{ needle: "python", tag: "python" }]);
  });

  it("returns an empty array when the file is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-lang-hints-"));
    tempRoots.push(root);

    await expect(loadLanguageHints(root)).resolves.toEqual([]);
  });

  it("returns an empty array when JSON is corrupted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-lang-hints-"));
    tempRoots.push(root);
    await writeHintsFile(root, "{ not valid json");

    await expect(loadLanguageHints(root)).resolves.toEqual([]);
  });
});
