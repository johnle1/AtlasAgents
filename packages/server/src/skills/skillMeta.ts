/**
 * Parses declarative JSON metadata from skill files (sidecar or inline block).
 */

import type { LoadedSkill, SkillIndex, SkillMeta } from "./types.js";

/** Regular expression to match inline markdown JSON blocks at the start of a skill file. */
const INLINE_META_RE = /^```json\s+skill-meta\s*\n([\s\S]*?)\n```\s*\n?/i;

/** Default empty metadata object structure. */
const EMPTY_META: SkillMeta = {
  stacks: [],
  domain: false,
  priority: 0,
  keywords: [],
};

/**
 * Coerces a value to a normalized array of lowercase, non-empty strings.
 *
 * @param value - value to convert
 * @returns array of lowercase strings
 */
const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((str) => str.trim().toLowerCase())
    .filter((str) => str.length > 0);
};

/**
 * Normalizes and validates raw metadata into a standard SkillMeta object.
 *
 * @param raw - raw metadata object
 * @returns validated SkillMeta object with defaults for missing fields
 */
export const normaliseSkillMeta = (raw: unknown): SkillMeta => {
  if (!raw || typeof raw !== "object") {
    return { ...EMPTY_META };
  }
  const record = raw as Record<string, unknown>;
  return {
    stacks: asStringArray(record.stacks),
    domain: record.domain === true,
    priority:
      typeof record.priority === "number" && Number.isFinite(record.priority)
        ? Math.floor(record.priority)
        : 0,
    keywords: asStringArray(record.keywords),
  };
};

/**
 * Parses a JSON string into a SkillMeta object, returning null if invalid or empty.
 *
 * @param text - JSON string to parse
 * @returns parsed SkillMeta or null
 */
export const parseSkillMetaJson = (text: string): SkillMeta | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return normaliseSkillMeta(JSON.parse(trimmed));
  } catch {
    return null;
  }
};

/**
 * Parses skill markdown by extracting inline metadata, merging with optional sidecar metadata,
 * and returning the cleaned markdown body.
 *
 * @param markdown - markdown text
 * @param [sidecarRaw] - optional sidecar metadata object
 * @returns {body, meta} cleaned markdown and merged metadata
 */
export const parseSkillDocument = (
  markdown: string,
  sidecarRaw?: unknown,
): { body: string; meta: SkillMeta } => {
  let body = markdown;
  let meta = sidecarRaw !== undefined ? normaliseSkillMeta(sidecarRaw) : null;
  const inline = INLINE_META_RE.exec(markdown);
  if (inline) {
    const parsed = parseSkillMetaJson(inline[1]);
    if (parsed) {
      meta = meta
        ? {
            stacks: meta.stacks.length > 0 ? meta.stacks : parsed.stacks,
            domain: meta.domain || parsed.domain,
            priority: Math.max(meta.priority, parsed.priority),
            keywords: [...new Set([...meta.keywords, ...parsed.keywords])],
          }
        : parsed;
    }
    body = markdown.slice(inline[0].length).trimStart();
  }
  return { body, meta: meta ?? { ...EMPTY_META } };
};

/**
 * Indexes skills by their stack mappings, tracking domain skills and resolving priority conflicts.
 *
 * @param skills - loaded skills map
 * @returns index mapping stacks to skills and tracking domain skills
 */
export const buildSkillIndex = (
  skills: Map<string, LoadedSkill>,
): SkillIndex => {
  const stackToSkill = new Map<string, string>();
  const domainSkillNames = new Set<string>();
  for (const [name, skill] of skills) {
    if (skill.meta.domain) {
      domainSkillNames.add(name);
    }
    for (const stackId of skill.meta.stacks) {
      const existing = stackToSkill.get(stackId);
      const prevPriority = existing
        ? skills.get(existing)!.meta.priority
        : -1;
      if (skill.meta.priority >= prevPriority) {
        stackToSkill.set(stackId, name);
      }
    }
  }
  return { stackToSkill, domainSkillNames };
};

/**
 * Scores a skill's relevance to a task using keyword matching.
 * Keywords match (3 pts), name match (2 pts), content preview match (1 pt).
 *
 * @param skill - skill to score
 * @param taskWords - array of lowercase task keywords
 * @returns relevance score
 */
export const scoreSkillForTask = (
  skill: LoadedSkill,
  taskWords: string[],
): number => {
  const nameLower = skill.name.toLowerCase();
  const preview = skill.content.slice(0, 200).toLowerCase();
  const keywordSet = new Set(skill.meta.keywords);
  let score = 0;
  for (const word of taskWords) {
    if (keywordSet.has(word)) {
      score += 3;
    }
    if (nameLower.includes(word)) {
      score += 2;
    }
    if (preview.includes(word)) {
      score += 1;
    }
  }
  return score;
};
