/**
 * <Summary>
 * What it does:
 *   Schedules periodic memory consolidation to run weekly.
 *
 * How it does it (step by step):
 *   1. Define weekly interval in milliseconds.
 *   2. Create async function to check if consolidation is due.
 *   3. Check last consolidation timestamp from config.
 *   4. If overdue (more than a week) or never run, perform consolidation.
 *   5. Update last consolidation timestamp after successful run.
 *   6. Run immediately on startup, then set interval for weekly execution.
 *   7. Unref timer to allow process to exit if needed.
 *
 * How it fits in the system:
 *   Provides automated memory maintenance by periodically consolidating
 *   preference rules and removing redundant data. This prevents the
 *   memory system from growing indefinitely and improves performance.
 *
 * Parameters:
 *   @param dependencies - Config and preference store dependencies.
 *
 * Returns:
 *   void — called for side effects (timer setup and consolidation scheduling).
 * </Summary>
 */

/**
 * <Summary>
 * What it does:
 *   Defines the dependencies required to schedule consolidation.
 *
 * How it fits in the system:
 *   Provides a minimal interface for the consolidation scheduler,
 *   allowing it to check timestamps and perform consolidation without
 *   requiring access to the full service graph.
 *
 * Used by:
 *   - scheduleConsolidation — receives these dependencies.
 *
 * Produced by:
 *   - Container — provides these dependencies when calling scheduleConsolidation.
 * </Summary>
 */
export type ConsolidationSchedulerDeps = {
  /**
   * Configuration manager interface for timestamp operations.
   * Provides methods to read and write the last consolidation timestamp.
   */
  config: {
    /**
     * Retrieves all configuration values including lastConsolidatedAt.
     * Used to check when consolidation was last run.
     */
    getAll: () => Promise<Record<string, unknown>>;

    /**
     * Updates a specific configuration value.
     * Used to update the lastConsolidatedAt timestamp.
     *
     * @param configKey - The configuration key to update.
     * @param configValue - The new value for the configuration key.
     */
    set: (configKey: string, configValue: unknown) => Promise<void>;
  };

  /**
   * Preference store interface for consolidation operations.
   * Provides the method to perform the actual consolidation.
   */
  prefs: {
    /**
     * Performs memory consolidation operation.
     * Merges similar rules and removes redundant data.
     */
    consolidate: () => Promise<void>;
  };
};

/**
 * <Summary>
 * What it does:
 *   Schedules periodic memory consolidation to run weekly.
 *
 * How it does it (step by step):
 *   1. Extract configuration and preference store from dependencies.
 *   2. Calculate weekly interval in milliseconds.
 *   3. Define async function to check if consolidation is due.
 *   4. Run consolidation immediately on startup if due.
 *   5. Set interval timer for weekly execution.
 *   6. Unref timer to allow clean process exit.
 *
 * Parameters:
 *   @param dependencies - Config and preference store dependencies.
 *
 * Returns:
 *   void — called for side effects (timer setup and consolidation scheduling).
 * </Summary>
 */
export const scheduleConsolidation = (
  dependencies: ConsolidationSchedulerDeps,
): void => {
  // ===== STEP 1: EXTRACT DEPENDENCIES =====
  // Extract config and preference store from dependencies object
  const { config, prefs } = dependencies;

  // ===== STEP 2: CALCULATE WEEKLY INTERVAL =====
  // Calculate one week in milliseconds (7 days * 24 hours * 60 minutes * 60 seconds * 1000 ms)
  // This defines how often consolidation should run
  const weeklyIntervalMilliseconds = 7 * 24 * 60 * 60 * 1000;

  /**
   * <Summary>
   * What it does:
   *   Runs consolidation if it's been more than a week since last run.
   *
   * How it does it (step by step):
   *   1. Get current configuration to check last consolidation time.
   *   2. Parse last consolidation timestamp to milliseconds.
   *   3. Calculate if consolidation is due (more than a week ago or never run).
   *   4. If due, run consolidation and update timestamp.
   *   5. Log errors if consolidation fails.
   *
   * Parameters:
   *   None — uses config and prefs through closure.
   *
   * Returns:
   *   void — called for side effects (consolidation and timestamp update).
   * </Summary>
   */
  const runConsolidationIfDue = async (): Promise<void> => {
    try {
      // ===== STEP 1: GET CURRENT CONFIGURATION =====
      // Retrieve all configuration values to check last consolidation timestamp
      const currentConfiguration = await config.getAll();

      // ===== STEP 2: EXTRACT LAST CONSOLIDATION TIMESTAMP =====
      // Extract the lastConsolidatedAt value from configuration
      const lastConsolidationTimestamp = (
        currentConfiguration as Record<string, unknown>
      ).lastConsolidatedAt;

      // ===== STEP 3: PARSE TIMESTAMP TO MILLISECONDS =====
      // Convert ISO string timestamp to milliseconds since epoch
      // If timestamp is missing or invalid, result will be NaN
      const lastConsolidationMilliseconds =
        typeof lastConsolidationTimestamp === "string"
          ? Date.parse(lastConsolidationTimestamp)
          : Number.NaN;

      // ===== STEP 4: CHECK IF CONSOLIDATION IS DUE =====
      // Consolidation is due if:
      // - Timestamp is invalid (NaN) = never run before
      // - Time since last consolidation >= weekly interval
      const isConsolidationDue =
        !Number.isFinite(lastConsolidationMilliseconds) ||
        Date.now() - lastConsolidationMilliseconds >=
          weeklyIntervalMilliseconds;

      // ===== STEP 5: EXIT IF NOT DUE =====
      // If consolidation was run recently, skip this execution
      if (!isConsolidationDue) {
        return;
      }

      // ===== STEP 6: PERFORM CONSOLIDATION =====
      // Run the consolidation operation to merge similar rules and remove redundant data
      await prefs.consolidate();

      // ===== STEP 7: UPDATE TIMESTAMP =====
      // Update the last consolidation timestamp to current time in ISO format
      // This prevents consolidation from running again until next week
      await config.set("lastConsolidatedAt", new Date().toISOString());
    } catch (error) {
      // ===== STEP 8: HANDLE CONSOLIDATION ERRORS =====
      // Log errors without crashing the server
      // Consolidation failures should not prevent the server from running
      console.error("[Consolidate]", error);
    }
  };

  // ===== STEP 3: RUN CONSOLIDATION IMMEDIATELY =====
  // Run consolidation check on startup to handle overdue consolidations
  // This ensures consolidation runs even if server was down during scheduled time
  void runConsolidationIfDue();

  // ===== STEP 4: SET INTERVAL TIMER =====
  // Schedule consolidation to run every week
  // The timer will call runConsolidationIfDue() at the specified interval
  const consolidationTimer = setInterval(() => {
    void runConsolidationIfDue();
  }, weeklyIntervalMilliseconds);

  // ===== STEP 5: UNREF TIMER =====
  // Unreference the timer to allow the process to exit cleanly
  // Without this, the timer would keep the Node.js process alive indefinitely
  // This allows the server to shut down when there are no other active operations
  consolidationTimer.unref();
};
