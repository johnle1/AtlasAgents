/**
 * Unit tests — macOS Seatbelt profile builder.
 *
 * Category checklist:
 * - Normal: deny default, write allow for cwd/tmp, read deny for secrets
 * - Boundary: cwd is resolved; quotes in paths are escaped
 * - Error: missing cwd still produces a parseable profile
 */

import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSeatbeltProfile,
  SEATBELT_DENIAL_PATTERN,
} from "../../../../packages/client/src/fileProxy/sandbox/seatbelt.js";

describe("buildSeatbeltProfile", () => {
  it("denies by default and allows process/exec/mach (normal)", () => {
    const profile = buildSeatbeltProfile({ cwd: "/proj" });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process*)");
    expect(profile).toContain("(allow mach*)");
    expect(profile).toContain("(allow network*)");
  });

  it("allows writes under cwd and tmp (normal)", () => {
    const cwd = path.resolve("/proj");
    const profile = buildSeatbeltProfile({ cwd });
    expect(profile).toContain(`(allow file-write* (subpath "${cwd}"))`);
    expect(profile).toContain(
      `(allow file-write* (subpath "${os.tmpdir()}"))`,
    );
  });

  it("denies reads of ~/.ssh ~/.aws ~/.gnupg (normal)", () => {
    const profile = buildSeatbeltProfile({ cwd: "/proj" });
    const home = os.homedir();
    expect(profile).toContain(
      `(deny file-read* (subpath "${path.join(home, ".ssh")}"))`,
    );
    expect(profile).toContain(
      `(deny file-read* (subpath "${path.join(home, ".aws")}"))`,
    );
    expect(profile).toContain(
      `(deny file-read* (subpath "${path.join(home, ".gnupg")}"))`,
    );
  });

  it("escapes quotes in cwd (boundary)", () => {
    const profile = buildSeatbeltProfile({ cwd: '/tmp/weird"dir' });
    expect(profile).toContain('\\"');
    expect(profile).not.toMatch(/subpath "\/tmp\/weird"dir"/);
  });

  describe("TMPDIR", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("also allows writes under $TMPDIR when it differs from os.tmpdir() (boundary)", () => {
      vi.stubEnv("TMPDIR", "/custom/tmp");
      const profile = buildSeatbeltProfile({ cwd: "/proj" });
      expect(profile).toContain(
        `(allow file-write* (subpath "${path.resolve("/custom/tmp")}"))`,
      );
    });

    it("does not add a TMPDIR write rule when TMPDIR is unset (boundary)", () => {
      vi.stubEnv("TMPDIR", "");
      const profile = buildSeatbeltProfile({ cwd: "/proj" });
      const writeRuleCount = (
        profile.match(/\(allow file-write\*/g) ?? []
      ).length;
      expect(writeRuleCount).toBe(2); // cwd + os.tmpdir() only
    });
  });
});

describe("SEATBELT_DENIAL_PATTERN", () => {
  it("matches sandbox deny and Operation not permitted (normal)", () => {
    expect(SEATBELT_DENIAL_PATTERN.test("sandbox deny file-write*")).toBe(
      true,
    );
    expect(SEATBELT_DENIAL_PATTERN.test("Operation not permitted")).toBe(true);
    expect(SEATBELT_DENIAL_PATTERN.test("npm ERR!")).toBe(false);
  });
});
