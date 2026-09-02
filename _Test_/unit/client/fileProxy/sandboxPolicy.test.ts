/**
 * Unit tests — sandbox policy derivation.
 *
 * Category checklist:
 * - Normal: writeRoots include cwd and os.tmpdir(); network passes through
 * - Boundary: darwin includes the Keychains deny entry, other platforms don't
 * - Error: none (pure function, no failure modes)
 */

import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReadDenies,
  buildSandboxPolicy,
} from "../../../../packages/client/src/fileProxy/sandbox/policy.js";

describe("buildSandboxPolicy", () => {
  it("includes cwd and the OS temp dir in writeRoots (normal)", () => {
    const policy = buildSandboxPolicy({ cwd: "/proj", network: "allow" });
    expect(policy.writeRoots).toContain(path.resolve("/proj"));
    expect(policy.writeRoots).toContain(os.tmpdir());
  });

  it("passes the network mode through unchanged (normal)", () => {
    expect(buildSandboxPolicy({ cwd: "/proj", network: "deny" }).network).toBe(
      "deny",
    );
    expect(
      buildSandboxPolicy({ cwd: "/proj", network: "allow" }).network,
    ).toBe("allow");
  });

  it("includes the credential-store deny list", () => {
    const policy = buildSandboxPolicy({ cwd: "/proj", network: "allow" });
    const paths = policy.readDenies.map((entry) => entry.path);
    expect(paths).toContain(path.join(os.homedir(), ".ssh"));
    expect(paths).toContain(path.join(os.homedir(), ".npmrc"));
  });
});

describe("buildReadDenies — platform differences", () => {
  it("includes Library/Keychains on darwin (boundary)", () => {
    const paths = buildReadDenies("darwin").map((entry) => entry.path);
    expect(paths).toContain(path.join(os.homedir(), "Library", "Keychains"));
  });

  it("does not include Library/Keychains on linux (boundary)", () => {
    const paths = buildReadDenies("linux").map((entry) => entry.path);
    expect(paths).not.toContain(path.join(os.homedir(), "Library", "Keychains"));
  });

  it("does not include Library/Keychains on win32 (boundary)", () => {
    const paths = buildReadDenies("win32").map((entry) => entry.path);
    expect(paths).not.toContain(path.join(os.homedir(), "Library", "Keychains"));
  });

  it("includes the shared cross-platform entries on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const paths = buildReadDenies(platform).map((entry) => entry.path);
      expect(paths).toContain(path.join(os.homedir(), ".ssh"));
      expect(paths).toContain(path.join(os.homedir(), ".git-credentials"));
    }
  });
});
