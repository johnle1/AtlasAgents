/**
 * Helper functions for skill manager including directory operations, tokenization, file operations, and skill loading.
 *
 * @remarks
 * Provides utility functions for file I/O, text processing, and skill loading.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { INVALID_FS_CHARS, STOP_WORDS } from "./skillConstants.js";
import { parseSkillDocument } from "./skillMeta.js";
import type { LoadedSkill } from "./types.js";
import { ValidationError } from "../errors/index.js";

export const isFileNotFound = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Recursively creates a directory if it doesn't exist.
 *
 * @param dir - absolute path to create
 */
export const ensureDir = async (dir: string): Promise<void> => {
  await fs.mkdir(dir, { recursive: true });
};

/**
 * Extracts significant keywords from text by lowercasing, splitting, and filtering stop words.
 *
 * @param text - input text to tokenize
 * @returns array of lowercase keywords (3+ chars, not stop words)
 */
export const tokenise = (text: string): string[] => {
  const lower = text.toLowerCase();
  const words = lower.split(/[^a-z0-9]+/u).filter((word) => word.length > 0);
  return words.filter((word) => word.length > 2 && !STOP_WORDS.has(word));
};

/**
 * Normalizes skills to a consistent Map format, handling both array and object inputs.
 *
 * @param skills - skills in [{name, content}] or {name: content} format
 * @returns map of skill names to content
 */
export const normaliseSkillsMap = (
  skills: Array<{ name: string; content: string }> | Record<string, string>,
): Map<string, string> => {
  const map = new Map<string, string>();
  // Handle array input format: [{name: "skill1", content: "..."}, ...]
  if (Array.isArray(skills)) {
    for (const entry of skills) {
      const name = entry.name.trim();
      if (name.length === 0) continue; // Skip empty names to prevent invalid keys
      map.set(name, entry.content);
    }
    return map;
  }
  // Handle object input format: {skill1: "...", skill2: "..."}
  for (const [name, content] of Object.entries(skills)) {
    const key = name.trim();
    if (key.length === 0) continue; // Skip empty keys
    map.set(key, content);
  }
  return map;
};

/**
 * Sanitizes a skill name to a safe .md filename, removing invalid characters and ensuring extension.
 *
 * @param basename - skill name (may contain separators or extensions)
 * @returns sanitized filename
 * @throws ValidationError if the name becomes empty after sanitization
 */
export const skillFileName = (basename: string): string => {
  const safe = basename
    .replace(/[/\\]/g, "")
    .replace(/\.md$/i, "")
    .replace(INVALID_FS_CHARS, "")
    .trim();
  if (!safe) {
    throw new ValidationError(`Invalid skill name: ${basename}`);
  }
  return `${safe}.md`;
};

/**
 * Reads optional metadata JSON sidecar file for a skill ({basename}.meta.json).
 *
 * @param dir - directory containing the sidecar
 * @param basename - skill name without extension
 * @returns parsed metadata or undefined if file not found
 */
export const readSidecarMeta = async (
  dir: string,
  basename: string,
): Promise<unknown | undefined> => {
  const metaPath = path.join(dir, `${basename}.meta.json`);
  try {
    const text = await fs.readFile(metaPath, "utf-8");
    return JSON.parse(text) as unknown;
  } catch (err) {
    if (isFileNotFound(err)) {
      // File doesn't exist — this is expected for skills without metadata
      return undefined;
    }
    // Rethrow real filesystem or parse errors
    throw err;
  }
};

/**
 * Reads and parses a skill markdown file and its optional metadata sidecar.
 *
 * @param dir - directory containing the skill
 * @param basename - skill name without extension
 * @returns loaded skill or null if markdown file not found
 */
export const readSkillFromDir = async (
  dir: string,
  basename: string,
): Promise<LoadedSkill | null> => {
  const mdPath = path.join(dir, `${basename}.md`);
  // Read the markdown body and the optional sidecar concurrently — they're
  // independent files, so there's no reason to wait on one before starting the other.
  const [rawResult, sidecar] = await Promise.all([
    fs.readFile(mdPath, "utf-8").catch((err) => {
      if (isFileNotFound(err)) {
        return null;
      }
      throw err;
    }),
    readSidecarMeta(dir, basename),
  ]);
  if (rawResult === null) {
    // Markdown file doesn't exist — safe to return null
    return null;
  }

  // Parse markdown body and extract frontmatter/metadata
  const { body, meta } = parseSkillDocument(rawResult, sidecar);
  return { name: basename, content: body, meta };
};

/**
 * Loads all skill markdown files from a directory, reading in parallel.
 *
 * @param dir - path to directory containing skill files
 * @returns map of skill names to loaded skill objects
 */
export const loadSkillsFromDir = async (
  dir: string,
): Promise<Map<string, LoadedSkill>> => {
  const map = new Map<string, LoadedSkill>();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (isFileNotFound(err)) {
      // Directory doesn't exist — return empty map (will be created on first save)
      return map;
    }
    // Rethrow real errors
    throw err;
  }

  // Extract unique basenames from .md files to avoid duplicate loads
  // (e.g., skill.md and skill.meta.json both map to "skill")
  const basenames = extractSkillBasenames(entries);

  // Load all skill files concurrently — they're independent reads, so awaiting
  // them one at a time in sequence only adds latency without any benefit.
  const loaded = await Promise.all(
    [...basenames].map((basename) =>
      readSkillFromDir(dir, basename).then((skill) => [basename, skill] as const),
    ),
  );
  for (const [basename, skill] of loaded) {
    if (skill) {
      map.set(basename, skill);
    }
  }
  return map;
};

/**
 * Extracts unique skill basenames from directory entries by filtering .md files.
 *
 * @param entries - directory entries
 * @returns set of skill basenames
 */
const extractSkillBasenames = (entries: string[]): Set<string> => {
  const basenames = new Set<string>();
  for (const file of entries) {
    if (file.endsWith(".md")) {
      basenames.add(file.replace(/\.md$/i, ""));
    }
  }
  return basenames;
};

/**
 * Lists skill names from a directory without reading file contents or metadata.
 * Use this lightweight alternative to loadSkillsFromDir when only names are needed.
 *
 * @param dir - directory containing skill files
 * @returns array of skill basenames
 */
export const listSkillBasenames = async (dir: string): Promise<string[]> => {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (isFileNotFound(err)) {
      return [];
    }
    throw err;
  }

  return [...extractSkillBasenames(entries)];
};
