/**
 * Manages skill markdown files: persistence, CRUD operations, and intelligent skill selection for tasks.
 *
 * @remarks
 * This interface abstracts the server-side skill storage layer from orchestration concerns.
 * Skills are persisted in `user-data/skills/*.md` with metadata in parallel `.meta.json` sidecars.
 * The manager intelligently selects relevant skills for tasks using BM25-like relevance scoring,
 * with a fallback chain: stack-specific skill → "coding" skill → best-scored skill → empty.
 *
 * **Usage context:**
 * - **AgentOrchestrator.runTask** — calls `selectForTask` to provide skill context during planning.
 * - **Router /skills endpoints** — uses `saveAll`, `loadAll`, `list`, `delete` for CRUD operations.
 * - **Client skill sync** — calls `saveAll` to persist client-side skill edits to the server.
 *
 * @example
 * ```ts
 * const manager = skillManagerInstance;
 * const skills = await manager.selectForTask("implement a React component", { detectedStack: "typescript" });
 * Returns primary stack skill + relevant domain skills for the task
 * ```
 */
export interface ISkillManager {
  /**
   * Intelligently selects the most relevant skill(s) for a task based on task text and optional stack context.
   *
   * @remarks
   * Scores each skill using BM25-like term frequency weighting on tokenized task text.
   * When `detectedStack` is provided, prioritizes the stack-specific skill; falls back to "coding" skill
   * or the best-scored skill. Returns an empty array if no skills are stored or none match the task.
   *
   * @param taskText - User task description for relevance scoring and keyword extraction.
   * @param ctx - Optional context hints. Set `detectedStack` to a language/framework name
   *   (e.g., `"python"`, `"typescript"`, `"go"`) to prefer stack-specific skills.
   * @returns Array of skill objects `{name, content}` sorted by relevance. Index 0 is the primary skill
   *   (stack-specific or best match); index 1+ are additional domain-specific skills meeting the threshold.
   *   Returns empty array if no suitable skills are available.
   *
   * @example
   * ```ts
   * const skills = await manager.selectForTask("write a Python unit test", { detectedStack: "python" });
   * if (skills.length > 0) {
   *   console.log(skills[0].name); // "python" or similar stack skill
   * }
   * ```
   */
  selectForTask(
    taskText: string,
    ctx?: { detectedStack?: string },
  ): Promise<Array<{ name: string; content: string }>>;

  /**
   * Replaces all skill markdown files with a new complete set, enforcing client as source of truth.
   *
   * @remarks
   * Implements "replace all" semantics — the incoming set completely replaces prior state (no merge).
   * Performs atomic writes to prevent partial-file corruption on crash. Cleans up orphaned `.meta.json`
   * sidecars for deleted skills (cascade delete).
   *
   * @param skills - New complete skill set. Accepts either:
   *   - Array format: `[{name: "skill1", content: "markdown..."}, ...]`
   *   - Object format: `{skill1: "markdown...", skill2: "markdown..."}` (object keys become skill names)
   * @returns Count of skills successfully written to disk.
   *
   * @example
   * ```ts
   * const skills = [
   *   { name: "python", content: "# Python Skill\n\nBest practices..." },
   *   { name: "typescript", content: "# TypeScript Skill\n\n..." }
   * ];
   * const count = await manager.saveAll(skills);
   * console.log(`Persisted ${count} skills`);
   * ```
   */
  saveAll(
    skills: Array<{ name: string; content: string }> | Record<string, string>,
  ): Promise<number>;

  /**
   * Loads all skill markdown files from disk as a map of skill name to content.
   *
   * @remarks
   * Gracefully returns an empty map if the directory is missing (it will be created on the first `saveAll`).
   * Skill names are derived from `.md` file basenames without the extension (e.g., `"skill.md"` → `"skill"`).
   * Associated `.meta.json` sidecars are loaded for indexing but only markdown content is returned.
   *
   * @returns Map of skill name → markdown content (empty when no skills are stored or directory is missing).
   *
   * @example
   * ```ts
   * const skillsMap = await manager.loadAll();
   * for (const [name, content] of skillsMap) {
   *   console.log(`Skill: ${name}, length: ${content.length}`);
   * }
   * ```
   */
  loadAll(): Promise<Map<string, string>>;

  /**
   * Returns all skill basenames in stable alphabetical order.
   *
   * @remarks
   * Fast enumeration that loads skill names without reading full markdown content.
   * Commonly used by the `/skills/list` endpoint and CLI completion.
   *
   * @returns Sorted array of skill names (empty when no skills are stored or directory is missing).
   *
   * @example
   * ```ts
   * const names = await manager.list();
   * console.log(names); // ["python", "typescript", "web-frontend"]
   * ```
   */
  list(): Promise<string[]>;

  /**
   * Removes one skill file (and its metadata sidecar) from disk by name.
   *
   * @remarks
   * Idempotent — calling multiple times with the same name will not error; it returns `false` on miss.
   * Cascade deletes both the `.md` content file and any associated `.meta.json` metadata file.
   *
   * @param name - Skill name without the `.md` extension. For example, `"python"` removes `python.md` and `python.meta.json`.
   * @returns `true` if at least one file (`.md` or `.meta.json`) was successfully deleted; `false` if the skill name was not found.
   *
   * @example
   * ```ts
   * const wasDeleted = await manager.delete("deprecated-skill");
   * if (wasDeleted) {
   *   console.log("Skill removed");
   * }
   * ```
   */
  delete(name: string): Promise<boolean>;
}
