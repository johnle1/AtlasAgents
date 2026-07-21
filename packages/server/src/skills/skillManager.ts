/**
 * Manages skill markdown files stored in user-data/skills/, syncing them from the client and providing intelligent skill selection for tasks based on relevance scoring.
 *
 * @remarks
 * - Implements ISkillManager interface used by AgentOrchestrator and Router - Acts as the server-side skill file persistence and retrieval layer - Handles skill CRUD operations and task-based skill selection
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ISkillManager } from "../orchestration/interfaces.js";
import {
  buildSkillIndex,
  parseSkillDocument,
  scoreSkillForTask,
} from "./skillMeta.js";
import type { LoadedSkill } from "./types.js";
import { DOMAIN_MIN_SCORE, SKILLS_REL_DIR } from "./skillConstants.js";
import {
  ensureDir,
  isFileNotFound,
  listSkillBasenames,
  loadSkillsFromDir,
  normaliseSkillsMap,
  skillFileName,
  tokenise,
} from "./skillHelpers.js";

/**
 * Persists and selects skill markdown files for orchestration tasks.
 *
 * @remarks
 * Implements ISkillManager interface; used by AgentOrchestrator to select skills and by Router /skills endpoint to sync client skills to server. Key methods: - saveAll: persist skills from client to disk - loadAll: retrieve all saved skills - selectForTask: intelligently choose most relevant skill for a task - list: enumerate all available skill names - delete: remove a skill
 */
export class SkillManager implements ISkillManager {
  private readonly skillsDir: string;

  /**
   * Initializes the SkillManager with a skills directory path.
   *
   * @param deps - dependency object
   * @param [deps.rootDir] — base directory for user data (defaults to cwd)
   */
  constructor(readonly deps: { rootDir?: string } = {}) {
    const rootDir = deps.rootDir ?? process.cwd();
    this.skillsDir = path.join(rootDir, SKILLS_REL_DIR);
  }

  /**
   * Deletes a metadata sidecar file, ignoring ENOENT (file not found) errors.
   */
  private async deleteMetaFile(mdFile: string): Promise<void> {
    const metaBase = mdFile.replace(/\.md$/i, "");
    try {
      await fs.unlink(path.join(this.skillsDir, `${metaBase}.meta.json`));
    } catch (err) {
      if (!isFileNotFound(err)) {
        throw err;
      }
    }
  }

  /**
   * Loads all skills from disk with full metadata.
   *
   * @returns skills map with metadata
   */
  private loadAllLoaded = async (): Promise<Map<string, LoadedSkill>> =>
    loadSkillsFromDir(this.skillsDir);

  /**
   * Persists a complete skill set to disk, replacing all existing skills with atomic writes.
   * Cleans up any skills removed from the client by deleting their .md and .meta.json files.
   *
   * @param skills - skills in array [{name, content}] or object {name: content} format
   * @returns count of skills successfully written
   */
  saveAll = async (
    skills: Array<{ name: string; content: string }> | Record<string, string>,
  ): Promise<number> => {
    // Normalize to consistent Map format, handling both array and object inputs
    const incoming = normaliseSkillsMap(skills);
    // Ensure target directory exists
    await ensureDir(this.skillsDir);

    // Write all incoming skills to disk concurrently — each write targets a
    // distinct file (via its own temp path), so there's no need to serialize them.
    await Promise.all(
      [...incoming].map(async ([name, content]) => {
        // Parse and validate markdown
        const { body } = parseSkillDocument(content);
        const filePath = path.join(this.skillsDir, skillFileName(name));
        // Use atomic write: temp file + rename to prevent corruption on crash
        const tempPath = path.join(this.skillsDir, `.skill-${randomUUID()}.tmp`);
        try {
          await fs.writeFile(tempPath, body, "utf-8");
          await fs.rename(tempPath, filePath);
        } catch (err) {
          await fs.unlink(tempPath).catch(() => {});
          throw err;
        }
      }),
    );
    const saved = incoming.size;

    // Clean up any existing skills not in the incoming set
    let existing: string[] = [];
    try {
      existing = await fs.readdir(this.skillsDir);
    } catch (err) {
      if (!isFileNotFound(err)) {
        throw err;
      }
      // Directory may not exist yet on first sync
    }

    // Build set of incoming skill filenames for comparison
    const incomingNames = new Set(
      [...incoming.keys()].map((skillName) => skillFileName(skillName)),
    );
    // Delete any .md files not in incoming set (removed from client), concurrently —
    // each deletion targets a distinct file pair, independent of the others.
    const filesToRemove = existing.filter(
      (file) => file.endsWith(".md") && !incomingNames.has(file),
    );
    await Promise.all(
      filesToRemove.map(async (file) => {
        // Delete the markdown file
        await fs.unlink(path.join(this.skillsDir, file));
        // Also delete any associated metadata file
        await this.deleteMetaFile(file);
      }),
    );

    return saved;
  };

  /**
   * Loads all persisted skills and returns just their markdown content (metadata discarded).
   *
   * @returns map of skill names to content strings
   */
  loadAll = async (): Promise<Map<string, string>> => {
    const loaded = await this.loadAllLoaded();
    const map = new Map<string, string>();
    for (const [name, skill] of loaded) {
      map.set(name, skill.content);
    }
    return map;
  };

  /**
   * Selects the most relevant skills for a task using scoring and detected tech stack.
   * Returns up to 2 skills: a primary stack-specific skill and an optional domain-relevant skill.
   *
   * @param taskText - user's task description
   * @param [ctx.detectedStack] - user's technology stack (e.g., "python", "javascript")
   * @returns array of selected skills
   */
  selectForTask = async (
    taskText: string,
    ctx?: { detectedStack?: string },
  ): Promise<Array<{ name: string; content: string }>> => {
    const skills = await this.loadAllLoaded();
    if (skills.size === 0) {
      return [];
    }

    const index = buildSkillIndex(skills);
    const taskWords = tokenise(taskText);

    let best: LoadedSkill | null = null;
    let bestScore = 0;
    let domainBest: LoadedSkill | null = null;
    let domainBestScore = 0;

    // Single pass through skills: score each one and track both best overall and best high-scoring domain-relevant skill
    for (const skill of skills.values()) {
      const score = scoreSkillForTask(skill, taskWords);
      if (score > bestScore) {
        bestScore = score;
        best = skill;
      }
      if (score >= DOMAIN_MIN_SCORE && score > domainBestScore) {
        domainBestScore = score;
        domainBest = skill;
      }
    }

    // Determine stack skill with linear fallback chain
    const stackId = ctx?.detectedStack?.trim().toLowerCase();
    const preferred = stackId ? index.stackToSkill.get(stackId) : undefined;
    const stackSkill =
      (preferred && skills.get(preferred)) ||
      skills.get("coding") ||
      best ||
      null;

    if (!stackSkill) {
      return [];
    }

    const result: Array<{ name: string; content: string }> = [
      { name: stackSkill.name, content: stackSkill.content },
    ];

    if (domainBest && domainBest.name !== stackSkill.name) {
      result.push({ name: domainBest.name, content: domainBest.content });
    }

    return result;
  };

  /**
   * Lists all skill names without reading file contents (lightweight alternative to loadAll).
   *
   * @returns array of skill names
   */
  list = async (): Promise<string[]> => listSkillBasenames(this.skillsDir);

  /**
   * Deletes a skill and its metadata sidecar file by name.
   *
   * @param name - skill name to delete
   * @returns true if deleted, false if not found
   */
  delete = async (name: string): Promise<boolean> => {
    // Generate safe filename and construct full path
    const mdFile = skillFileName(name);
    const filePath = path.join(this.skillsDir, mdFile);
    try {
      // Delete the markdown file
      await fs.unlink(filePath);
    } catch (err) {
      if (isFileNotFound(err)) {
        // Skill doesn't exist
        return false;
      }
      // Rethrow real errors
      throw err;
    }
    // Clean up optional metadata file
    await this.deleteMetaFile(mdFile);
    return true;
  };
}

/** Exported for tests — parse inline JSON skill-meta from markdown. */
export { parseSkillDocument };
