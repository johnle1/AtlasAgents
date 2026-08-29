/**
 * Unit tests — fileProxy/envScrub.
 *
 * Category checklist:
 * - Normal: strips token/secret/password/key-shaped names, keeps everything else
 * - Boundary: case-insensitive match; exceptions list is not stripped
 * - Error: undefined values are dropped entirely (not passed through as "undefined")
 */

import { describe, expect, it } from "vitest";
import { scrubEnv } from "../../../../packages/client/src/fileProxy/envScrub.js";

describe("scrubEnv", () => {
  it("strips common credential-shaped variable names (normal)", () => {
    const result = scrubEnv({
      PATH: "/usr/bin",
      GITHUB_TOKEN: "ghp_xxx",
      OPENAI_API_KEY: "sk-xxx",
      DATABASE_PASSWORD: "hunter2",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      NPM_TOKEN: "npm-xxx",
      DOCKER_CREDENTIALS: "blob",
    });
    expect(result).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps ordinary toolchain variables (normal)", () => {
    const input = {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      GOPATH: "/home/dev/go",
      CARGO_HOME: "/home/dev/.cargo",
      HTTP_PROXY: "http://proxy:8080",
      LANG: "en_US.UTF-8",
    };
    expect(scrubEnv(input)).toEqual(input);
  });

  it("matches case-insensitively (boundary)", () => {
    const result = scrubEnv({ my_secret_thing: "x", PATH: "/usr/bin" });
    expect(result).toEqual({ PATH: "/usr/bin" });
  });

  it("does not strip SSH_AUTH_SOCK / GPG_AGENT_INFO / GPG_TTY despite matching 'auth' loosely (boundary — exceptions)", () => {
    const result = scrubEnv({
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      GPG_AGENT_INFO: "/tmp/gpg-agent",
      GPG_TTY: "/dev/ttys001",
    });
    expect(result).toEqual({
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      GPG_AGENT_INFO: "/tmp/gpg-agent",
      GPG_TTY: "/dev/ttys001",
    });
  });

  it("drops keys with undefined values rather than passing through 'undefined' (error)", () => {
    const result = scrubEnv({ PATH: "/usr/bin", UNSET_VAR: undefined });
    expect(result).toEqual({ PATH: "/usr/bin" });
    expect("UNSET_VAR" in result).toBe(false);
  });

  it("defaults to process.env when called with no argument", () => {
    const original = process.env.SCRUB_ENV_TEST_TOKEN;
    process.env.SCRUB_ENV_TEST_TOKEN = "leak-me-not";
    try {
      const result = scrubEnv();
      expect(result.SCRUB_ENV_TEST_TOKEN).toBeUndefined();
      expect(result.PATH).toBe(process.env.PATH);
    } finally {
      if (original === undefined) {
        delete process.env.SCRUB_ENV_TEST_TOKEN;
      } else {
        process.env.SCRUB_ENV_TEST_TOKEN = original;
      }
    }
  });
});
