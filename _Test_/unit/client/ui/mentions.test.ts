/**
 * Unit tests — client ui/mentions/expand.ts
 *
 * `@path` inlines file/dir contents via an injected resolver (no fs).
 *
 * Category checklist:
 * - Normal: `@file` inlines content; `@dir` inlines a listing
 * - Boundary: unknown `@` left literal; email-like tokens left literal
 * - Error: missing/unreadable, secret files, binary, oversize — inline reason
 */

import { describe, expect, it } from "vitest";
import {
  MAX_MENTION_BYTES,
  completeMention,
  expandMentions,
  type MentionResolver,
} from "../../../../packages/client/src/ui/mentions/expand.js";

const fixtureResolver = (files: {
  [path: string]:
    | { kind: "file"; content: string; size?: number }
    | { kind: "dir"; listing: string[] }
    | { kind: "missing" };
}): MentionResolver => ({
  stat: async (mentionPath) => {
    const entry = files[mentionPath];
    if (!entry || entry.kind === "missing") {
      return { kind: "missing", name: mentionPath.split("/").pop() ?? mentionPath };
    }
    if (entry.kind === "dir") {
      return { kind: "dir", name: mentionPath.split("/").pop() ?? mentionPath };
    }
    return {
      kind: "file",
      name: mentionPath.split("/").pop() ?? mentionPath,
      size: entry.size ?? Buffer.byteLength(entry.content, "utf8"),
    };
  },
  readText: async (mentionPath) => {
    const entry = files[mentionPath];
    if (!entry || entry.kind !== "file") {
      throw new Error("unreadable");
    }
    return entry.content;
  },
  listDir: async (mentionPath) => {
    const entry = files[mentionPath];
    if (!entry || entry.kind !== "dir") {
      throw new Error("not a directory");
    }
    return entry.listing;
  },
});

describe("expandMentions (normal)", () => {
  it("inlines a file as a fenced content block", async () => {
    const { text } = await expandMentions(
      "see @README.md please",
      fixtureResolver({
        "README.md": { kind: "file", content: "# Hello\n" },
      }),
    );
    expect(text).toContain("# File: README.md");
    expect(text).toContain("# Hello");
    expect(text).not.toMatch(/see @README\.md please/);
  });

  it("inlines a directory listing", async () => {
    const { text } = await expandMentions(
      "look at @src",
      fixtureResolver({
        src: { kind: "dir", listing: ["a.ts", "b.ts"] },
      }),
    );
    expect(text).toContain("# Directory: src");
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
  });
});

describe("expandMentions (boundary)", () => {
  it("leaves unknown @tokens that are not path-like literal", async () => {
    const { text } = await expandMentions(
      "ping @alice later",
      fixtureResolver({}),
    );
    expect(text).toBe("ping @alice later");
  });

  it("leaves email-like tokens literal", async () => {
    const { text } = await expandMentions(
      "write to user@example.com",
      fixtureResolver({}),
    );
    expect(text).toBe("write to user@example.com");
  });
});

describe("expandMentions (error)", () => {
  it("inlines an error when the path is missing", async () => {
    const { text } = await expandMentions(
      "open @missing.ts",
      fixtureResolver({ "missing.ts": { kind: "missing" } }),
    );
    expect(text).toMatch(/Could not read @missing\.ts/i);
  });

  it("refuses secret-ish files such as .env", async () => {
    const { text } = await expandMentions(
      "dump @.env",
      fixtureResolver({
        ".env": { kind: "file", content: "SECRET=1\n" },
      }),
    );
    expect(text).toMatch(/Refused to read @\.env/i);
    expect(text).not.toContain("SECRET=1");
  });

  it("rejects binary content with a reason", async () => {
    const { text } = await expandMentions(
      "see @blob.bin",
      fixtureResolver({
        "blob.bin": { kind: "file", content: "a\0b" },
      }),
    );
    expect(text).toMatch(/binary|non-text/i);
  });

  it("rejects oversize files with a reason", async () => {
    const { text } = await expandMentions(
      "see @huge.txt",
      fixtureResolver({
        "huge.txt": {
          kind: "file",
          content: "x",
          size: MAX_MENTION_BYTES + 1,
        },
      }),
    );
    expect(text).toMatch(/too large/i);
  });
});

describe("completeMention (normal / boundary)", () => {
  it("completes the last @token against matching names (normal)", () => {
    expect(completeMention("see @READ", ["README.md", "src"])).toBe(
      "see @README.md",
    );
  });

  it("returns null when nothing matches (boundary)", () => {
    expect(completeMention("see @zzz", ["README.md"])).toBeNull();
  });
});
