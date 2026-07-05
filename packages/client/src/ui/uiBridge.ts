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
} from "./bridge/history.js";

export {
  setSpinner,
  setAgentStatus,
  removeAgentStatus,
  clearAgentStatuses,
  setAgentBoards,
  updateAgentActivity,
  clearAgentBoards,
} from "./bridge/agentStatus.js";

export {
  setBusy,
  setTaskActive,
  getTaskActive,
  isTaskActive,
  setCwdLabel,
  refreshInkBanner,
  enterAlternateScreen,
  exitAlternateScreen,
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
