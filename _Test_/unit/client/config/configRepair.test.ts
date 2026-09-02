/**
 * Unit tests — client cli/configRepair.ts: the offline `--reset`/`--password`/
 * `--address`/`--port` flow that changes saved connection settings without a
 * server connection.
 *
 * @remarks
 * This is the escape hatch from the bootstrap deadlock (the in-app `/set`
 * commands only exist after a successful connect), so the properties that
 * matter are: the passphrase genuinely gates the write, a wrong passphrase
 * changes nothing, and a reset clears the pinned TLS fingerprints that would
 * otherwise keep refusing a rebuilt server.
 *
 * `config/types.ts` derives its config directory from `os.homedir()` at module
 * load, so HOME/USERPROFILE are overridden (via {@link createTempHome}) before
 * the modules are imported dynamically in `beforeAll` — the same pattern as
 * configUnlock.test.ts. Vitest isolates each file's module registry, so this
 * does not leak into other test files.
 *
 * `runConfigRepair` reuses one injected prompt for both the passphrase and the
 * new server password, so the scripted answers below are ordered: passphrase
 * first, then any password.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempHome, type TempHome } from "../../../helpers/tempHome.js";

describe("configRepair.ts — offline connection-settings repair", () => {
  let runConfigRepair: typeof import("../../../../packages/client/src/cli/configRepair.js").runConfigRepair;
  let loadConfig: typeof import("../../../../packages/client/src/config/index.js").loadConfig;
  let setConfig: typeof import("../../../../packages/client/src/config/index.js").setConfig;
  let isConnectionConfigured: typeof import("../../../../packages/client/src/config/index.js").isConnectionConfigured;
  let unlockOrSetupConfigCipher: typeof import("../../../../packages/client/src/config/index.js").unlockOrSetupConfigCipher;
  let lockCipher: typeof import("@atlasagents/shared").lockCipher;
  let tempHome: TempHome;
  let configFile: string;

  /**
   * Returns a prompt function that replays `answers` in order.
   *
   * @param answers - Replies to give, in the order the flow asks for them.
   * @returns The prompt callback plus the labels it was called with, so tests
   *   can assert *what* was asked, not just how many times.
   */
  const scriptedPrompt = (
    answers: string[],
  ): {
    prompt: (label: string) => Promise<string>;
    labels: string[];
  } => {
    const labels: string[] = [];
    let index = 0;
    return {
      labels,
      prompt: async (label: string) => {
        labels.push(label);
        if (index >= answers.length) {
          throw new Error(`Unexpected extra prompt: ${label}`);
        }
        return answers[index++]!;
      },
    };
  };

  /** Creates an encrypted config representing a working, configured client. */
  const seedConfiguredClient = async (passphrase: string): Promise<void> => {
    await unlockOrSetupConfigCipher(async () => passphrase);
    setConfig("server", "10.0.0.7");
    setConfig("port", 8001);
    setConfig("password", "old-server-password");
    setConfig("serverFingerprints", { "10.0.0.7:8001": "AA:BB:CC" });
    setConfig("ui", { ...loadConfig().ui, theme: "ocean" });
    lockCipher(); // simulate a fresh process: the file stays, the key does not
  };

  beforeAll(async () => {
    tempHome = createTempHome("atlas-config-repair-test-");
    configFile = path.join(tempHome.dir, ".atlasagents", "config.json");

    const configMod = await import("../../../../packages/client/src/config/index.js");
    loadConfig = configMod.loadConfig;
    setConfig = configMod.setConfig;
    isConnectionConfigured = configMod.isConnectionConfigured;
    unlockOrSetupConfigCipher = configMod.unlockOrSetupConfigCipher;

    const repairMod = await import("../../../../packages/client/src/cli/configRepair.js");
    runConfigRepair = repairMod.runConfigRepair;

    const cipherMod = await import("@atlasagents/shared");
    lockCipher = cipherMod.lockCipher;
  });

  afterAll(() => {
    tempHome.restore();
  });

  afterEach(() => {
    lockCipher();
    fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
  });

  describe("--reset", () => {
    it("clears the password, address, port, and pinned fingerprints", async () => {
      await seedConfiguredClient("repair-pass");

      const { prompt } = scriptedPrompt(["repair-pass"]);
      await runConfigRepair({ reset: true, password: false }, prompt);

      const config = loadConfig();
      expect(config.password).toBe("");
      expect(config.server).toBe("localhost");
      expect(config.port).toBe(7000);
      expect(config.serverFingerprints).toEqual({});
    });

    it("preserves settings unrelated to the connection", async () => {
      await seedConfiguredClient("repair-pass");

      const { prompt } = scriptedPrompt(["repair-pass"]);
      await runConfigRepair({ reset: true, password: false }, prompt);

      expect(loadConfig().ui.theme).toBe("ocean");
    });

    it("leaves the client flagged as needing setup, so the next launch runs the wizard", async () => {
      // seedConfiguredClient leaves a saved password, so the client counts as
      // configured going in.
      await seedConfiguredClient("repair-pass");

      const { prompt } = scriptedPrompt(["repair-pass"]);
      await runConfigRepair({ reset: true, password: false }, prompt);

      // This is what index.ts checks to decide between the setup wizard and a
      // connection attempt — a reset must land in the wizard, not in a retry of
      // the connection that just failed.
      expect(isConnectionConfigured(loadConfig())).toBe(false);
    });

    it("leaves the file encrypted, with no plaintext secrets", async () => {
      await seedConfiguredClient("repair-pass");

      const { prompt } = scriptedPrompt(["repair-pass"]);
      await runConfigRepair({ reset: true, password: false }, prompt);

      const raw = fs.readFileSync(configFile, "utf-8");
      expect(raw).toContain("$secrets");
      expect(raw).not.toContain("10.0.0.7");
    });
  });

  describe("--address / --port / --password", () => {
    it("saves a new address and port without touching the password", async () => {
      await seedConfiguredClient("repair-pass");

      const { prompt } = scriptedPrompt(["repair-pass"]);
      await runConfigRepair(
        { reset: false, password: false, server: "192.168.1.50", port: 9100 },
        prompt,
      );

      const config = loadConfig();
      expect(config.server).toBe("192.168.1.50");
      expect(config.port).toBe(9100);
      expect(config.password).toBe("old-server-password");
    });

    it("prompts separately for the new server password and saves it", async () => {
      await seedConfiguredClient("repair-pass");

      const { prompt, labels } = scriptedPrompt([
        "repair-pass",
        "brand-new-server-password",
      ]);
      await runConfigRepair({ reset: false, password: true }, prompt);

      expect(labels[0]).toMatch(/config passphrase/i);
      expect(labels[1]).toMatch(/new server password/i);
      expect(loadConfig().password).toBe("brand-new-server-password");
    });

    it("applies a combined reset-and-repoint in one command", async () => {
      await seedConfiguredClient("repair-pass");

      const { prompt } = scriptedPrompt(["repair-pass", "new-password"]);
      await runConfigRepair(
        { reset: true, password: true, server: "192.168.1.50", port: 9100 },
        prompt,
      );

      const config = loadConfig();
      expect(config.server).toBe("192.168.1.50");
      expect(config.port).toBe(9100);
      expect(config.password).toBe("new-password");
      // The reset still clears stale pins, even though the other fields were
      // immediately overwritten by the explicit flags.
      expect(config.serverFingerprints).toEqual({});
    });
  });

  describe("--trust-fingerprint", () => {
    it("clears the pinned fingerprint for the configured server:port", async () => {
      await seedConfiguredClient("repair-pass");

      const { prompt } = scriptedPrompt(["repair-pass"]);
      await runConfigRepair(
        { reset: false, password: false, trustFingerprint: true },
        prompt,
      );

      expect(loadConfig().serverFingerprints).toEqual({});
    });

    it("leaves other config fields untouched", async () => {
      await seedConfiguredClient("repair-pass");

      const { prompt } = scriptedPrompt(["repair-pass"]);
      await runConfigRepair(
        { reset: false, password: false, trustFingerprint: true },
        prompt,
      );

      const config = loadConfig();
      expect(config.server).toBe("10.0.0.7");
      expect(config.port).toBe(8001);
      expect(config.password).toBe("old-server-password");
    });

    it("does not clear the pin when the passphrase is wrong and the user aborts", async () => {
      await seedConfiguredClient("repair-pass");
      // The cipher is locked at this point (seedConfiguredClient's doing), so
      // the file — not loadConfig(), which would throw on a locked cipher —
      // is the only way to check nothing changed. serverFingerprints is a
      // plaintext top-level field (only password/server live in $secrets),
      // so its pin is readable straight out of the raw JSON.
      const before = fs.readFileSync(configFile, "utf-8");

      const { prompt } = scriptedPrompt(["nope-1", "nope-2", "nope-3", "q"]);
      await expect(
        runConfigRepair(
          { reset: false, password: false, trustFingerprint: true },
          prompt,
        ),
      ).rejects.toThrow(/aborted/i);

      expect(fs.readFileSync(configFile, "utf-8")).toBe(before);
      expect(before).toContain("10.0.0.7:8001");
    });

    it("clears the pin for a newly-repointed server when combined with --address", async () => {
      await seedConfiguredClient("repair-pass");

      const { prompt } = scriptedPrompt(["repair-pass"]);
      await runConfigRepair(
        {
          reset: false,
          password: false,
          trustFingerprint: true,
          server: "10.0.0.7",
          port: 9999,
        },
        prompt,
      );

      // The old host:port pin is untouched — nothing was ever pinned for the
      // new port — while the repointed target has nothing pinned either.
      expect(loadConfig().serverFingerprints).toEqual({
        "10.0.0.7:8001": "AA:BB:CC",
      });
    });

    it("is a no-op report (not an error) when nothing was pinned", async () => {
      // Seeded directly (rather than via seedConfiguredClient) so
      // serverFingerprints stays at its default {} — setConfig cannot run
      // after seedConfiguredClient's lockCipher() without unlocking again.
      await unlockOrSetupConfigCipher(async () => "repair-pass");
      setConfig("server", "10.0.0.7");
      setConfig("port", 8001);
      setConfig("password", "old-server-password");
      lockCipher();

      const { prompt } = scriptedPrompt(["repair-pass"]);
      await expect(
        runConfigRepair(
          { reset: false, password: false, trustFingerprint: true },
          prompt,
        ),
      ).resolves.toBeUndefined();
    });

    it("does not double-report when combined with --reset, which already clears every pin", async () => {
      await seedConfiguredClient("repair-pass");

      const { prompt } = scriptedPrompt(["repair-pass"]);
      await runConfigRepair(
        { reset: true, password: false, trustFingerprint: true },
        prompt,
      );

      expect(loadConfig().serverFingerprints).toEqual({});
    });
  });

  describe("passphrase gating", () => {
    it("re-prompts on a wrong passphrase and then applies the change", async () => {
      await seedConfiguredClient("repair-pass");

      const { prompt, labels } = scriptedPrompt(["wrong-pass", "repair-pass"]);
      await runConfigRepair(
        { reset: false, password: false, port: 9100 },
        prompt,
      );

      expect(labels).toHaveLength(2);
      expect(loadConfig().port).toBe(9100);
    });

    it("writes nothing when the user aborts at the passphrase prompt", async () => {
      await seedConfiguredClient("repair-pass");
      const before = fs.readFileSync(configFile, "utf-8");

      // Three wrong entries reach the recovery menu; "q" quits.
      const { prompt } = scriptedPrompt(["nope-1", "nope-2", "nope-3", "q"]);
      await expect(
        runConfigRepair({ reset: true, password: false }, prompt),
      ).rejects.toThrow(/aborted/i);

      expect(fs.readFileSync(configFile, "utf-8")).toBe(before);
    });

    it("falls through to the forgotten-passphrase recovery menu after three wrong entries", async () => {
      await seedConfiguredClient("repair-pass");

      const { prompt } = scriptedPrompt([
        "nope-1",
        "nope-2",
        "nope-3",
        "r", // reset the cipher
        "yes", // confirm
        "brand-new-passphrase",
        "brand-new-server-password",
      ]);
      await runConfigRepair({ reset: false, password: true }, prompt);

      // The recovery menu discarded the old secrets; the repair then wrote the
      // new password under the new passphrase.
      const config = loadConfig();
      expect(config.password).toBe("brand-new-server-password");
      expect(config.server).toBe("localhost");

      // A backup of the unreadable config survives for anyone who later
      // remembers the original passphrase.
      const backups = fs
        .readdirSync(path.dirname(configFile))
        .filter((name) => name.startsWith("config.json.bak-"));
      expect(backups).toHaveLength(1);
    });
  });
});
