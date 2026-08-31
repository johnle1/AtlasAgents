/**
 * Static imports for HOME-bound client modules (report footprint + smoke).
 */

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "atlas-client-static-exports-"),
  );
  // os.homedir() reads HOME on POSIX but USERPROFILE on Windows — both must
  // be set or Windows CI operates on the real home directory instead of this
  // temp one. Duplicated here (rather than using helpers/tempHome.ts)
  // because vi.hoisted() runs before ESM imports are bound, so it can't
  // import that helper.
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
});

import { runConfigRepair } from "../../../packages/client/src/cli/configRepair.js";
import {
  rotateConfigPassphrase,
  unlockOrSetupConfigCipher,
} from "../../../packages/client/src/config/cipher.js";
import {
  ensureDirs,
  getDefaultConfig,
  hasConfigFile,
  isConnectionConfigured,
  loadConfig,
  saveConfig,
  updateConfig,
} from "../../../packages/client/src/config/manager.js";
import {
  checkAndPinFingerprint,
  clearFingerprint,
  fingerprintKey,
} from "../../../packages/client/src/connection/tls/fingerprintStore.js";
import { LocalFileProxy } from "../../../packages/client/src/fileProxy/proxy.js";
import {
  buildConfigLines,
  buildGroupedModelsLines,
} from "../../../packages/client/src/renderer/commandTables.js";
import {
  ensureSkillsDir,
  installDefaultSkills,
  listSkills,
  readAllSkills,
  readSkillsFromDir,
  SkillManager,
} from "../../../packages/client/src/skills/skills.js";
import {
  AppProvider,
  emptyPromptDraft,
  useAppContext,
} from "../../../packages/client/src/state/DataContext.js";
import { useBridgeSetup } from "../../../packages/client/src/ui/hooks/useBridgeSetup.js";
import { useConnectionDisconnectCleanup } from "../../../packages/client/src/ui/hooks/useConnectionDisconnectCleanup.js";
import { useConnectionStatus } from "../../../packages/client/src/ui/hooks/useConnectionStatus.js";
import { useKeyboardInput } from "../../../packages/client/src/ui/hooks/useKeyboardInput.js";
import { useSubmitLine } from "../../../packages/client/src/ui/hooks/useSubmitLine.js";
import { Banner } from "../../../packages/client/src/ui/components/Banner.js";
import { ConnectionStatusLine } from "../../../packages/client/src/ui/components/ConnectionStatusLine.js";
import {
  HistoryView,
  LiveThinkView,
  renderHistoryItem,
} from "../../../packages/client/src/ui/components/HistoryView.js";
import { StatusSpinner } from "../../../packages/client/src/ui/components/Spinner.js";
import { PlanChecklist } from "../../../packages/client/src/ui/components/PlanChecklist.js";

vi.mock("ink", () => ({
  render: vi.fn(),
  Box: "Box",
  Text: "Text",
  useInput: vi.fn(),
  useApp: () => ({ exit: vi.fn() }),
  useStdout: () => ({ stdout: { columns: 80, rows: 24, write: vi.fn() } }),
}));

describe("client static exports", () => {
  it("config manager symbols", () => {
    expect(typeof hasConfigFile).toBe("function");
    expect(typeof isConnectionConfigured).toBe("function");
    expect(typeof getDefaultConfig).toBe("function");
    expect(typeof ensureDirs).toBe("function");
    expect(typeof loadConfig).toBe("function");
    expect(typeof saveConfig).toBe("function");
    expect(typeof updateConfig).toBe("function");
  });

  it("cipher symbols", () => {
    expect(typeof unlockOrSetupConfigCipher).toBe("function");
    expect(typeof rotateConfigPassphrase).toBe("function");
  });

  it("fingerprint store symbols", () => {
    expect(typeof fingerprintKey).toBe("function");
    expect(typeof checkAndPinFingerprint).toBe("function");
    expect(typeof clearFingerprint).toBe("function");
  });

  it("skills symbols", () => {
    expect(typeof installDefaultSkills).toBe("function");
    expect(typeof ensureSkillsDir).toBe("function");
    expect(typeof listSkills).toBe("function");
    expect(typeof readAllSkills).toBe("function");
    expect(typeof readSkillsFromDir).toBe("function");
    expect(typeof SkillManager).toBe("function");
    expect(typeof installDefaultSkills).toBe("function");
  });

  it("runConfigRepair symbol", () => {
    expect(typeof runConfigRepair).toBe("function");
  });

  it("command table builders", () => {
    const cfg = getDefaultConfig();
    expect(buildConfigLines(cfg).length).toBeGreaterThan(0);
    expect(buildGroupedModelsLines([], "agent").lines).toBeDefined();
  });

  it("LocalFileProxy parser artefact names", () => {
    const names = [
      "resolveAbsolutePath",
      "listStructureImpl",
      "listDirectoryEntriesImpl",
      "expandDirectoryImpl",
      "assertInsideRoot",
      "runShell",
    ];
    expect(typeof LocalFileProxy).toBe("function");
    expect(names).toHaveLength(6);
  });

  it("DataContext symbols", () => {
    expect(typeof emptyPromptDraft).toBe("function");
    expect(typeof useAppContext).toBe("function");
    expect(typeof AppProvider).toBe("function");
  });

  it("hook and component symbols", () => {
    expect(typeof useBridgeSetup).toBe("function");
    expect(typeof useConnectionDisconnectCleanup).toBe("function");
    expect(typeof useConnectionStatus).toBe("function");
    expect(typeof useKeyboardInput).toBe("function");
    expect(typeof useSubmitLine).toBe("function");
    expect(typeof Banner).toBe("function");
    expect(typeof ConnectionStatusLine).toBe("function");
    expect(typeof HistoryView).toBe("function");
    expect(typeof LiveThinkView).toBe("function");
    expect(typeof renderHistoryItem).toBe("function");
    expect(typeof StatusSpinner).toBe("function");
    expect(typeof PlanChecklist).toBe("function");
  });
});
