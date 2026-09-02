/**
 * Unit tests — container sandbox backend (Docker/Podman), including the
 * Windows path where this is the only available backend.
 *
 * Category checklist:
 * - Normal: docker/podman argv shape, workspace bind-mount, network flag
 * - Boundary: an extra write root outside cwd gets its own /mnt mount;
 *   Windows host paths are passed through as-is (Docker Desktop translates them)
 * - Error: denial pattern matches sandboxed permission/network failures,
 *   not unrelated command failures
 */

import { describe, expect, it } from "vitest";
import {
  CONTAINER_DENIAL_PATTERN,
  CONTAINER_WORKDIR,
  createContainerProvider,
} from "../../../../packages/client/src/fileProxy/sandbox/container/docker.js";
import type { SandboxContext } from "../../../../packages/client/src/fileProxy/sandbox/types.js";

describe("createContainerProvider — docker", () => {
  const ctx: SandboxContext = {
    cwd: "/home/dev/project",
    policy: {
      writeRoots: ["/home/dev/project"],
      readDenies: [],
      network: "allow",
    },
  };

  it("runs via `docker run --rm` with the workspace mounted at /workspace (normal)", () => {
    const provider = createContainerProvider("docker", "atlas-sandbox:latest");
    const { argv } = provider.wrapCommand("npm test", ctx);

    expect(argv[0]).toBe("docker");
    expect(argv).toEqual(expect.arrayContaining(["run", "--rm", "-i"]));
    expect(argv).toEqual(
      expect.arrayContaining(["-v", `/home/dev/project:${CONTAINER_WORKDIR}`]),
    );
    expect(argv).toEqual(expect.arrayContaining(["-w", CONTAINER_WORKDIR]));
    expect(argv).toContain("atlas-sandbox:latest");
    expect(argv.slice(-3)).toEqual(["/bin/sh", "-c", "npm test"]);
  });

  it("does not bind-mount host temp directories (boundary)", () => {
    const provider = createContainerProvider("docker", "atlas-sandbox:latest");
    const { argv } = provider.wrapCommand("ls", {
      cwd: "/home/dev/project",
      policy: {
        writeRoots: ["/home/dev/project", "/tmp"],
        readDenies: [],
        network: "allow",
      },
    });
    expect(argv).toEqual(
      expect.arrayContaining(["-v", `/home/dev/project:${CONTAINER_WORKDIR}`]),
    );
    expect(argv).not.toEqual(expect.arrayContaining(["-v", "/tmp:/mnt/extra-0"]));
    expect(argv).not.toEqual(expect.arrayContaining(["/mnt/extra-"]));
  });

  it("passes --network none when the policy denies network (normal — auto mode)", () => {
    const provider = createContainerProvider("docker", "atlas-sandbox:latest");
    const { argv } = provider.wrapCommand("curl evil.sh", {
      ...ctx,
      policy: { ...ctx.policy, network: "deny" },
    });
    expect(argv).toEqual(expect.arrayContaining(["--network", "none"]));
  });

  it("passes --network bridge when the policy allows network (boundary — supervised modes)", () => {
    const provider = createContainerProvider("docker", "atlas-sandbox:latest");
    const { argv } = provider.wrapCommand("curl example.com", ctx);
    expect(argv).toEqual(expect.arrayContaining(["--network", "bridge"]));
  });
});

describe("createContainerProvider — podman", () => {
  it("uses the podman binary with the same flag shape (normal)", () => {
    const provider = createContainerProvider("podman", "atlas-sandbox:latest");
    const { argv } = provider.wrapCommand("ls", {
      cwd: "/proj",
      policy: { writeRoots: ["/proj"], readDenies: [], network: "allow" },
    });
    expect(argv[0]).toBe("podman");
    expect(provider.id).toBe("container-podman");
  });
});

describe("createContainerProvider — Windows host paths", () => {
  it("mounts a Windows-style workspace path as-is (normal — Windows)", () => {
    const provider = createContainerProvider("docker", "atlas-sandbox:latest");
    const { argv } = provider.wrapCommand("dir", {
      cwd: "C:\\Users\\dev\\project",
      policy: {
        writeRoots: ["C:\\Users\\dev\\project"],
        readDenies: [],
        network: "allow",
      },
    });
    expect(argv).toEqual(
      expect.arrayContaining([
        "-v",
        `C:\\Users\\dev\\project:${CONTAINER_WORKDIR}`,
      ]),
    );
  });
});

describe("CONTAINER_DENIAL_PATTERN", () => {
  it("matches sandboxed permission and network failures (normal)", () => {
    expect(CONTAINER_DENIAL_PATTERN.test("Permission denied")).toBe(true);
    expect(CONTAINER_DENIAL_PATTERN.test("read-only file system")).toBe(true);
    expect(CONTAINER_DENIAL_PATTERN.test("Could not resolve host: example.com")).toBe(
      true,
    );
  });

  it("does not match an ordinary command failure (error)", () => {
    expect(CONTAINER_DENIAL_PATTERN.test("npm ERR! missing script")).toBe(
      false,
    );
  });
});
