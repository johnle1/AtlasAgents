/**
 * <Summary>
 * What it does:
 *   Bridges WorkspaceManager write approval to an injected handler (typically the
 *   CLI over RSocket) that shows a colored diff and collects accept/decline.
 *
 * How it fits in the system:
 *   Server-side gate before persisting agent-proposed file changes.
 *
 * Dependencies:
 *   None at module level — handler is injected at construction.
 *
 * Dependants:
 *   - WorkspaceManager.writeFile.
 * </Summary>
 */

/**
 * <Summary>
 * What it does:
 *   Payload sent to the UI layer when a file write needs human approval.
 *
 * Used by:
 *   - WriteConfirmationHandler implementations (client REPL, tests).
 * </Summary>
 */
export type WriteConfirmationRequest = {
  /** Workspace-relative path being written. */
  relativePath: string;

  /** Unified diff patch (plain text, no ANSI). */
  patch: string;

  /** Same patch with terminal colors for display. */
  coloredDiff: string;
};

/**
 * <Summary>
 * What it does:
 *   Async function that displays a write preview and resolves true when the user accepts.
 *
 * Used by:
 *   - ConfirmationBroker constructor.
 * </Summary>
 */
export type WriteConfirmationHandler = (
  request: WriteConfirmationRequest,
) => Promise<boolean>;

/**
 * <Summary>
 * What it does:
 *   Delegates write approval to an injected handler, with an optional auto-approve mode
 *   for headless runs and tests.
 *
 * Dependants:
 *   - WorkspaceManager.
 * </Summary>
 */
export class ConfirmationBroker {
  /**
   * <Summary>
   * How it does it (step by step):
   *   1. Store the write handler function that will be invoked when user interaction needed.
   *   2. Store the broker options (e.g., autoApprove flag) for configuration.
   *   3. Options allow headless mode to auto-approve without user prompts.
   *
   * Parameters:
   *   @param {WriteConfirmationHandler} userInteractionHandler — Async function that shows diff and returns user choice.
   *   @param {{ autoApprove?: boolean }} [brokerConfig] — Configuration options for this broker instance.
   *     - autoApprove: true → skip handler, always approve (used in CI/headless environments)
   *     - autoApprove: false/undefined → invoke handler, respect user decision
   * </Summary>
   */
  constructor(
    private readonly userInteractionHandler: WriteConfirmationHandler,
    private readonly brokerConfig: { autoApprove?: boolean } = {},
  ) {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Asks whether to apply a proposed file change (or auto-approves when configured).
   *
   * How it does it (step by step):
   *   1. Check if auto-approve mode is enabled in broker configuration.
   *   2. If auto-approve is enabled, immediately return true (skip user interaction).
   *   3. If not auto-approve, invoke the provided handler to show diff and get user choice.
   *   4. Return the user's decision (true = approve, false = decline).
   *
   * Parameters:
   *   @param {WriteConfirmationRequest} approvalRequest — Path and diff preview payloads.
   *
   * Returns:
   *   @returns {Promise<boolean>} — True when the write should proceed, false to decline.
   *
   * Dependants:
   *   - WorkspaceManager.writeFile.
   * </Summary>
   */
  requestWriteApproval = async (
    approvalRequest: WriteConfirmationRequest,
  ): Promise<boolean> => {
    // Step 1: Check if broker is configured to auto-approve all writes
    // This mode is used in headless/CI environments where user interaction is not possible
    const isAutoApproveEnabled = this.brokerConfig.autoApprove === true;

    // Step 2-3: If auto-approve is enabled, skip the handler and return true immediately
    // Otherwise, invoke the handler (typically displays colored diff and prompts user)
    if (isAutoApproveEnabled) {
      return true;
    }

    // Step 4: Return the handler's decision (user approved or declined the write)
    return this.userInteractionHandler(approvalRequest);
  };
}

/**
 * <Summary>
 * What it does:
 *   Factory for a broker that always approves writes (dev/CI without a terminal).
 *
 * How it does it (step by step):
 *   1. Create a dummy handler function that always returns true (ignores the request).
 *   2. Pass this handler to ConfirmationBroker constructor with autoApprove: true.
 *   3. When requestWriteApproval is called, broker auto-approves and never invokes the handler.
 *   4. Return the configured broker instance.
 *
 * Returns:
 *   @returns {ConfirmationBroker} — Broker with both autoApprove enabled and a no-op handler.
 *
 * Use cases:
 *   - Server bootstrap when no interactive client is attached
 *   - Automated testing environments
 *   - CI/CD pipelines where manual approval is not possible
 *
 * Dependants:
 *   - Server bootstrap when no interactive client is attached.
 * </Summary>
 */
export const createAutoApproveBroker = (): ConfirmationBroker => {
  // Step 1: Create a no-op handler that immediately resolves to true
  // This handler is never actually invoked (autoApprove bypasses it), but is required by ConfirmationBroker
  const noOpApprovalHandler = async (): Promise<boolean> => {
    return true;
  };

  // Step 2-4: Create and return broker with autoApprove enabled
  // Even though the handler will never be called, we provide it for type safety
  return new ConfirmationBroker(noOpApprovalHandler, { autoApprove: true });
};
