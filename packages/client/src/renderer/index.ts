/**
 * Public barrel for terminal / Ink history rendering helpers.
 *
 * @remarks
 * Prefer importing from this file (or `../renderer.js`) so callers do not depend
 * on internal splits (`sink`, `fileOperations`, …). Most `print*` functions push
 * into the UI history bridge via {@link appendBlock} / {@link appendText}.
 *
 * @example
 * ```ts
 * import { printError, printSuccess, printBash } from "./renderer/index.js";
 *
 * printSuccess("Connected");
 * printBash("ls -la", "safe");
 * ```
 */

export { CLI_VERSION } from "./version.js";
export { buildBannerLines } from "./banner.js";
export {
  buildConfigLines,
  printConfig,
  printModels,
  printGroupedModels,
  printProviders,
  printSkills,
  printMemory,
} from "./commandTables.js";
export {
  formatAgentThinkForDisplay,
} from "./agentThink.js";
export { printLine, printError, printSuccess } from "./messages.js";
export {
  printListDir,
  printRead,
  printTokenSaveOp,
  printTokenSaveResult,
  printWrite,
  printCreate,
  printCreateDir,
  printDelete,
  printCd,
  printListDirEntries,
} from "./fileOperations.js";
export {
  printBash,
  printBashResult,
  printBashApproved,
  printBashRan,
  printSkipped,
  printReviseRequested,
  printSuccessOp,
} from "./shellOperations.js";
export {
  type BashClass,
  type DirEntry,
  type ModelGroup,
  type FlatModelEntry,
  type CurrentModelSelection,
} from "./types.js";
export {
  printInstalledModels,
  printModelFind,
  printModelStorage,
  formatStorageBytes,
  printProgress,
  resetPullProgress,
  finishPullProgress,
} from "./modelOutput.js";
