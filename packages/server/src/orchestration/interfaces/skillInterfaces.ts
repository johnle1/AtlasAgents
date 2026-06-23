/**
 * <Summary>
 * What it does:
 *   Interface for skill management.
 *
 * How it fits in the system:
 *   Selects the single best-matching skill document for a natural-language task.
 * </Summary>
 */

/**
 * <Summary>
 * What it does:
 *   Selects the single best-matching skill document for a natural-language task.
 *
 * Used by:
 *   - AdvisorOrchestrator.runTask — supplies skill body to plan and agents.
 *
 * Produced by:
 *   - Future packages/server/src/skills/skillManager.ts implementation.
 * </Summary>
 */
export interface ISkillManager {
  /**
   * @async
   * <Summary>
   * What it does:
   *   Chooses one skill file by relevance to the task text, or returns null.
   *
   * Parameters:
   *   @param taskText - User task for matching.
   *
   * Returns:
   *   @returns Skill metadata and body.
   * </Summary>
   */
  selectForTask(
    taskText: string,
    ctx?: { detectedStack?: string },
  ): Promise<Array<{ name: string; content: string }>>;

  /**
   * <Summary>
   * What it does:
   *   Replaces all skill files under user-data/skills/ with the incoming map.
   * </Summary>
   */
  saveAll(
    skills: Array<{ name: string; content: string }> | Record<string, string>,
  ): Promise<number>;

  /**
   * <Summary>
   * What it does:
   *   Loads every .md skill as a Map of basename to content.
   * </Summary>
   */
  loadAll(): Promise<Map<string, string>>;

  /**
   * <Summary>
   * What it does:
   *   Returns all skill basenames (without .md extension).
   * </Summary>
   */
  list(): Promise<string[]>;

  /**
   * <Summary>
   * What it does:
   *   Removes one skill file by basename.
   * </Summary>
   */
  delete(name: string): Promise<boolean>;
}
