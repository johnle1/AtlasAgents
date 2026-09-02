/**
 * Unit tests — macOS Seatbelt profile builder.
 *
 * Category checklist:
 * - Normal: deny default, write allow for writeRoots, read deny for credential stores
 * - Boundary: quotes in paths are escaped; network policy toggles the rule
 * - Error: missing cwd still produces a parseable profile
 */

import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSeatbeltProfile,
  SEATBELT_DENIAL_PATTERN,
} from "../../../../packages/client/src/fileProxy/sandbox/seatbelt.js";
import { buildSandboxPolicy } from "../../../../packages/client/src/fileProxy/sandbox/policy.js";
import type { SandboxContext } from "../../../../packages/client/src/fileProxy/sandbox/types.js";

const ctxFor = (
  cwd: string,
  network: "allow" | "deny" = "allow",
): SandboxContext => ({
  cwd,
  policy: buildSandboxPolicy({ cwd, network, platform: "darwin" }),
});

const describeDarwin =
  process.platform === "darwin" ? describe : describe.skip;

describeDarwin("buildSeatbeltProfile", () => {
  it("denies by default and allows process/exec/mach (normal)", () => {
    const profile = buildSeatbeltProfile(ctxFor("/proj"));
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(allow process*)");
    expect(profile).toContain("(allow mach*)");
    expect(profile).toContain("(allow network*)");
  });

  it("allows writes under cwd and tmp (normal)", () => {
    const cwd = path.resolve("/proj");
    const profile = buildSeatbeltProfile(ctxFor(cwd));
    expect(profile).toContain(
      `(allow file-write* (subpath "${path.normalize(cwd)}"))`,
    );
    expect(profile).toContain(
      `(allow file-write* (subpath "${path.normalize(os.tmpdir())}"))`,
    );
  });

  it("denies reads of credential stores incl. ~/.ssh ~/.aws ~/.gnupg (normal)", () => {
    const profile = buildSeatbeltProfile(ctxFor("/proj"));
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
    // Widened deny list — see policy.ts.
    expect(profile).toContain(
      `(deny file-read* (subpath "${path.join(home, ".npmrc")}"))`,
    );
    expect(profile).toContain(
      `(deny file-read* (subpath "${path.join(home, "Library", "Keychains")}"))`,
    );
  });

  it("denies network when the policy says deny (normal — auto mode)", () => {
    const profile = buildSeatbeltProfile(ctxFor("/proj", "deny"));
    expect(profile).toContain("(deny network*)");
    expect(profile).not.toContain("(allow network*)");
  });

  it("escapes quotes in cwd (boundary)", () => {
    const profile = buildSeatbeltProfile(ctxFor('/tmp/weird"dir'));
    expect(profile).toContain('\\"');
    expect(profile).not.toMatch(/subpath "\/tmp\/weird"dir"/);
  });

  describe("TMPDIR", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("also allows writes under $TMPDIR when it differs from os.tmpdir() (boundary)", () => {
      vi.stubEnv("TMPDIR", "/custom/tmp");
      const profile = buildSeatbeltProfile(ctxFor("/proj"));
      expect(profile).toContain(
        `(allow file-write* (subpath "${path.resolve("/custom/tmp")}"))`,
      );
    });

    it("does not add a TMPDIR write rule when TMPDIR is unset (boundary)", () => {
      vi.stubEnv("TMPDIR", "");
      const profile = buildSeatbeltProfile(ctxFor("/proj"));
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
