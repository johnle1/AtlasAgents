/**
 * Schedules weekly memory consolidation to merge duplicate rules and optimize storage.
 *
 * @remarks
 * This module automates memory maintenance by periodically consolidating preference rules.
 * Consolidation uses the agent model to intelligently merge similar rules, reducing
 * redundancy and improving context builder performance as rules accumulate.
 *
 * **Scheduling:**
 * - First run: Immediately on startup (catches overdue consolidations)
 * - Subsequent runs: Every 7 days
 * - Timer is unreferenced to allow process exit when no other work is active
 *
 * @see {@link PreferenceStore.consolidate} for the consolidation implementation
 */

import type { ConsolidationSchedulerDeps } from "../types.js";

/**
 * Schedules and runs periodic memory consolidation.
 *
 * @remarks
 * Sets up a weekly consolidation check that:
 * 1. Runs immediately on startup (catches overdue consolidations from downtime)
 * 2. Re-runs every 7 days
 * 3. Updates the last-consolidation timestamp in config after each run
 * 4. Operates asynchronously without blocking server startup
 *
 * The timer is unreferenced (`unref()`) to allow the process to exit cleanly
 * when no other active operations are running.
 *
 * @param dependencies - Config manager and preference store
 *
 * @example
 * ```ts
 * const deps: ConsolidationSchedulerDeps = {
 *   config: configManager,
 *   prefs: preferenceStore
 * };
 * scheduleConsolidation(deps); // Runs immediately and every week
 * ```
 */
export const scheduleConsolidation = (
  dependencies: ConsolidationSchedulerDeps,
): void => {
  const { config, prefs } = dependencies;
  const weeklyIntervalMilliseconds = 7 * 24 * 60 * 60 * 1000;

  /**
   * Runs consolidation if it's been more than a week since the last run.
   *
   * @remarks
   * Checks the `lastConsolidatedAt` timestamp in config. If more than 7 days
   * have passed (or if consolidation has never run), calls {@link PreferenceStore.consolidate}
   * to merge duplicate rules and updates the timestamp. Errors are logged but
   * do not prevent the server from running.
   */
  const runConsolidationIfDue = async (): Promise<void> => {
    try {
      const currentConfiguration = await config.getAll();
      const lastConsolidationTimestamp = (
        currentConfiguration as Record<string, unknown>
      ).lastConsolidatedAt;

      const lastConsolidationMilliseconds =
        typeof lastConsolidationTimestamp === "string"
          ? Date.parse(lastConsolidationTimestamp)
          : Number.NaN;

      const isConsolidationDue =
        !Number.isFinite(lastConsolidationMilliseconds) ||
        Date.now() - lastConsolidationMilliseconds >=
          weeklyIntervalMilliseconds;

      if (!isConsolidationDue) {
        return;
      }

      await prefs.consolidate();
      await config.set("lastConsolidatedAt", new Date().toISOString());
    } catch (error) {
      console.error("[Consolidate]", error);
    }
  };

  void runConsolidationIfDue();

  const consolidationTimer = setInterval(() => {
    void runConsolidationIfDue();
  }, weeklyIntervalMilliseconds);

  consolidationTimer.unref();
};
