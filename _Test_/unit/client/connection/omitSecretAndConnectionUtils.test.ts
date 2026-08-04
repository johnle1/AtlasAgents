/**
 * Unit tests — omitSecretFields + connection utils.
 */

import { describe, expect, it } from "vitest";
import {
  omitSecretFields,
  type StoredConfig,
} from "../../../../packages/client/src/config/types.js";
import {
  authMetadata,
  requireSocket,
} from "../../../../packages/client/src/connection/utils.js";
import type { Config } from "../../../../packages/client/src/config/types.js";

describe("omitSecretFields", () => {
  it("removes password, server, and $secrets from stored config", () => {
    const stored: StoredConfig = {
      password: "secret",
      server: "host:1",
      workspace: "/home/user/projects",
      port: 7000,
      $secrets: {
        v: 1,
        salt: "c2FsdA==",
        iv: "aXY=",
        tag: "dGFn",
        data: "ZGF0YQ==",
      },
    };
    const scrubbed = omitSecretFields(stored);
    expect(scrubbed).not.toHaveProperty("password");
    expect(scrubbed).not.toHaveProperty("server");
    expect(scrubbed).not.toHaveProperty("$secrets");
    expect(scrubbed).toMatchObject({
      workspace: "/home/user/projects",
      port: 7000,
    });
  });
});

describe("authMetadata", () => {
  it("encodes the password as JSON metadata", () => {
    const buf = authMetadata({ password: "p@ss" } as Config);
    expect(JSON.parse(buf.toString("utf8"))).toEqual({ password: "p@ss" });
  });
});

describe("requireSocket", () => {
  it("returns the socket when present", () => {
    const sock = { kind: "rsocket" } as never;
    expect(requireSocket(sock)).toBe(sock);
  });

  it("throws when the socket is null", () => {
    expect(() => requireSocket(null)).toThrow();
  });
});
