/**
 * Bridge between non-React code and the Ink UI.
 * Re-exports from focused bridge modules; import from here for a stable public API.
 */

export type { BridgeHooks } from "./bridge/hooks.js";

export {
  setInkActive,
  isInkActive,
  registerBridgeHooks,
} from "./bridge/hooks.js";

export {
  appendHistory,
  appendLog,
  setStreamingText,
  appendStreamingToken,
  registerStreamingHandler,
  startLiveThink,
  appendLiveThink,
  endLiveThink,
  clearLiveThinks,
} from "./bridge/history.js";

export {
  setSpinner,
  setSubagentStatus,
  removeSubagentStatus,
  clearSubagentStatuses,
  setSubagentBoards,
  updateAgentActivity,
  clearSubagentBoards,
} from "./bridge/subagentStatus.js";

export {
  setBusy,
  setTaskActive,
  getTaskActive,
  isTaskActive,
  setCwdLabel,
  refreshInkBanner,
  enterAlternateScreen,
  exitAlternateScreen,
  setActiveTaskCancel,
  cancelActiveTask,
  clearScreen,
  setContextUsage,
} from "./bridge/display.js";

export {
  getPendingApproval,
  requestApproval,
  resolveApproval,
  cancelPendingApprovals,
} from "./bridge/approval.js";

export {
  getPendingPrompt,
  requestPrompt,
  resolvePrompt,
  cancelPendingPrompts,
} from "./bridge/prompt.js";
