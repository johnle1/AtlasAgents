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
import { createLazyValue } from "../utils/lazyValue.js";
import {
  buildSkillIndex,
  parseSkillDocument,
  scoreSkillForTask,
} from "./skillMeta.js";
import type { LoadedSkill, SkillIndex } from "./types.js";
import { DOMAIN_RELATIVE_THRESHOLD, SKILLS_REL_DIR } from "./skillConstants.js";
import {
  ensureDir,
  isFileNotFound,
  listSkillBasenames,
  loadSkillsFromDir,
  normaliseSkillsMap,
  readSkillFromDir,
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
   * Resident relevance index: tokenized name/body/keywords + IDF weights per
   * skill, rebuilt from disk only after `saveAll`/`delete` invalidate it, or
   * before the first `selectForTask` call. Deliberately holds no raw skill
   * content — see {@link SkillIndexEntry} — so it stays proportional to
   * vocabulary size, not total skill-file bytes.
   *
   * @remarks
   * {@link createLazyValue} handles the concurrency here: one shared in-flight
   * build, a failed build that retries rather than sticking, and an
   * `invalidate()` that a build already in flight cannot reinstate.
   */
  private readonly index = createLazyValue<SkillIndex>(() =>
    this.buildIndexFromDisk(),
  );

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
   * Returns the resident relevance index, building it from disk on first use
   * (or after a prior invalidation) and caching it thereafter.
   *
   * @remarks
   * Building the index still reads every skill's full content once (needed
   * to tokenize it — see {@link buildSkillIndex}), but that cost is paid
   * only when the index is stale, not on every `selectForTask` call. Concurrent
   * callers during a build share the same in-flight promise rather than
   * triggering redundant rebuilds.
   */
  private ensureIndexLoaded = async (): Promise<SkillIndex> => this.index.get();

  private buildIndexFromDisk = async (): Promise<SkillIndex> => {
    const skills = await this.loadAllLoaded();
    return buildSkillIndex(skills, tokenise);
  };

  /**
   * Drops the resident index so the next `selectForTask` rebuilds it from disk.
   *
   * @remarks
   * Also wins against a rebuild already in flight — that build's result is
   * discarded rather than being cached after this call, so a `saveAll` can
   * never be silently reverted by a read that started before it.
   */
  private invalidateIndex = (): void => {
    this.index.invalidate();
  };

  /**
   * Reads one skill's content directly from disk by name.
   *
   * @remarks
   * Used by `selectForTask` to fetch the winning skill(s)' body on demand —
   * the resident index never retains full content, so this targeted read
   * (1–2 files) replaces what used to be a full-directory read on every call.
   */
  private readSkillContent = async (name: string): Promise<string | null> => {
    const loaded = await readSkillFromDir(this.skillsDir, name);
    return loaded ? loaded.content : null;
  };

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

    // Invalidate up front, in a finally, rather than only after every step
    // below succeeds. Both Promise.all batches reject on the FIRST failure
    // without waiting for (or undoing) the others' side effects — a write 3
    // of 5 skills in still lands the other 4 on disk, and a cleanup deletion
    // failing after every write succeeded still means disk changed. Either
    // way `saveAll` throws before reaching an unconditional invalidate at
    // the end, leaving selectForTask serving a stale index built from
    // whatever was on disk before this call, indefinitely.
    try {
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
    } finally {
      // The resident relevance index may now be stale — drop it so the next
      // selectForTask rebuilds from what's actually on disk, whether this
      // call fully succeeded or threw partway through.
      this.invalidateIndex();
    }

    return incoming.size;
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
   * Selects the most relevant skills for a task using IDF-weighted scoring
   * and detected tech stack. Returns up to 2 skills: a primary
   * stack-specific skill and an optional domain-relevant skill.
   *
   * @param taskText - user's task description
   * @param [ctx.detectedStack] - user's technology stack (e.g., "python", "javascript")
   * @returns array of selected skills
   *
   * @remarks
   * Scoring runs entirely against the resident index (O(k) Set lookups per
   * skill, k = distinct task words) — no file reads. Only after the
   * winner(s) are chosen by name does this read their content from disk
   * (1–2 targeted reads instead of every skill file on every call).
   */
  selectForTask = async (
    taskText: string,
    ctx?: { detectedStack?: string },
  ): Promise<Array<{ name: string; content: string }>> => {
    const index = await this.ensureIndexLoaded();
    if (index.entries.size === 0) {
      return [];
    }

    const taskWordSet = new Set(tokenise(taskText));

    let best: string | null = null;
    let bestScore = 0;
    let domainBest: string | null = null;
    let domainBestScore = 0;

    // Single pass through skills: score each one and track both best overall and best high-scoring domain-relevant skill
    for (const entry of index.entries.values()) {
      const score = scoreSkillForTask(entry, taskWordSet, index.idf);
      if (score > bestScore) {
        bestScore = score;
        best = entry.name;
      }
      if (index.domainSkillNames.has(entry.name) && score > domainBestScore) {
        domainBestScore = score;
        domainBest = entry.name;
      }
    }

    // Determine stack skill with linear fallback chain
    const stackId = ctx?.detectedStack?.trim().toLowerCase();
    const preferredName = stackId ? index.stackToSkill.get(stackId) : undefined;
    const stackSkillName =
      (preferredName && index.entries.has(preferredName) ? preferredName : undefined) ??
      (index.entries.has("coding") ? "coding" : undefined) ??
      best ??
      null;

    if (!stackSkillName) {
      return [];
    }

    const primaryContent = await this.readSkillContent(stackSkillName);
    if (primaryContent === null) {
      // Skill vanished between index build and this read (e.g. concurrent
      // delete) — nothing usable to return for the primary slot.
      return [];
    }

    const result: Array<{ name: string; content: string }> = [
      { name: stackSkillName, content: primaryContent },
    ];

    // Relative (not absolute) threshold: scores are IDF-weighted floats with
    // no fixed scale, so "at least 30% as relevant as the best match" is the
    // bar that stays meaningful as the corpus and its vocabulary change.
    if (
      domainBest &&
      domainBest !== stackSkillName &&
      domainBestScore >= bestScore * DOMAIN_RELATIVE_THRESHOLD
    ) {
      const domainContent = await this.readSkillContent(domainBest);
      if (domainContent !== null) {
        result.push({ name: domainBest, content: domainContent });
      }
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
    this.invalidateIndex();
    return true;
  };
}

/** Exported for tests — parse inline JSON skill-meta from markdown. */
export { parseSkillDocument };
