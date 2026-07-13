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
  printSkills,
  printMemory,
} from "./commandTables.js";
export {
  formatAdvisorThinkForDisplay,
  formatAgentThinkForDisplay,
} from "./advisorThink.js";
export { printLine, printError, printSuccess } from "./messages.js";
export {
  printListDir,
  printRead,
  printTokenSaveOp,
  printWrite,
  printCreate,
  printCreateDir,
  printDelete,
  printCd,
  printListDirEntries,
  type DirEntry,
} from "./fileOperations.js";
export {
  printBash,
  printBashResult,
  printBashApproved,
  printBashRan,
  printSkipped,
  printSuccessOp,
  type BashClass,
} from "./shellOperations.js";
export {
  printInstalledModels,
  printModelFind,
  printProgress,
  resetPullProgress,
  finishPullProgress,
} from "./modelOutput.js";
