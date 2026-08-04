/**
 * Parses declarative JSON metadata from skill files (sidecar or inline block).
 */

import type { LoadedSkill, SkillIndex, SkillIndexEntry, SkillMeta } from "./types.js";
import {
  BODY_FIELD_WEIGHT,
  KEYWORD_FIELD_WEIGHT,
  MIN_IDF,
  NAME_FIELD_WEIGHT,
} from "./skillConstants.js";

/**
 * Regular expression to match an inline markdown JSON metadata block at the
 * start of a skill file, optionally preceded by a single markdown title
 * heading line (e.g. `# Testing skill`).
 *
 * @remarks
 * Every skill fixture and every real skill file authored against this
 * format starts with a `#` title heading — a strictly first-byte-of-file
 * anchor (the original pattern here) never actually matched any of them,
 * so `SkillMeta.keywords`/`domain`/`priority`/`stacks` silently fell back
 * to empty for every skill that had a title, which in practice is all of
 * them. The optional heading-capture group (group 1) fixes that while
 * staying conservative: the fence must still open the very next line, so
 * this can't accidentally match a code block appearing later in a skill's
 * prose (e.g. one demonstrating the metadata syntax itself).
 */
const INLINE_META_RE =
  /^(#[^\n]*\n+)?```json\s+skill-meta\s*\r?\n([\s\S]*?)\r?\n```\s*\r?\n?/i;

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
    // Group 1 is the optional leading heading line, group 2 is the JSON body —
    // see INLINE_META_RE's doc comment for why the heading is captured
    // separately rather than consumed as part of the stripped-out match.
    const parsed = parseSkillMetaJson(inline[2] ?? "");
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
    // Keep the heading (if any) as part of the body — only the metadata
    // block itself should be stripped out.
    const headingPrefix = inline[1] ?? "";
    body = (headingPrefix + markdown.slice(inline[0].length)).trimStart();
  }
  return { body, meta: meta ?? { ...EMPTY_META } };
};

/**
 * Indexes skills by their stack mappings, tokenizing every skill for scoring
 * and computing an IDF (inverse document frequency) weight per token.
 *
 * @param skills - loaded skills map
 * @param tokenize - tokenizer used for skill names and body content (callers
 *   pass {@link tokenise} from `skillHelpers.ts`; injected rather than
 *   imported directly here to avoid a circular module dependency, since
 *   `skillHelpers.ts` already imports from this module)
 * @returns index mapping stacks to skills, tracking domain skills, and
 *   holding per-skill token sets plus corpus-wide IDF weights for scoring
 *
 * @remarks
 * Reads each skill's full `content` once (to tokenize it) but the returned
 * index retains only the resulting token sets — not the content itself —
 * so repeated calls to `scoreSkillForTask` never re-scan skill bodies, and
 * the resident index is sized by vocabulary, not by total skill-file bytes.
 *
 * IDF uses the standard BM25-style formula
 * `ln(1 + (S - df + 0.5) / (df + 0.5))`, floored at {@link MIN_IDF} so a
 * token that's merely common (rather than universal) doesn't get
 * near-zeroed — a small corpus of skills produces noisy document
 * frequencies (df=1 vs df=2 swings the weight hard), and the floor keeps
 * that noise from suppressing a real match entirely.
 */
export const buildSkillIndex = (
  skills: Map<string, LoadedSkill>,
  tokenize: (text: string) => string[],
): SkillIndex => {
  const stackToSkill = new Map<string, string>();
  const domainSkillNames = new Set<string>();
  const entries = new Map<string, SkillIndexEntry>();
  const documentFrequency = new Map<string, number>();

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

    const nameTokens = new Set(tokenize(name));
    const bodyTokens = new Set(tokenize(skill.content));
    const keywordSet = new Set(skill.meta.keywords);
    const docTokens = new Set<string>([
      ...nameTokens,
      ...bodyTokens,
      ...keywordSet,
    ]);
    entries.set(name, { name, meta: skill.meta, nameTokens, bodyTokens, keywordSet, docTokens });

    for (const token of docTokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const skillCount = skills.size;
  const idf = new Map<string, number>();
  for (const [token, docFreq] of documentFrequency) {
    const rawIdf = Math.log(1 + (skillCount - docFreq + 0.5) / (docFreq + 0.5));
    idf.set(token, Math.max(rawIdf, MIN_IDF));
  }

  return { stackToSkill, domainSkillNames, entries, idf, skillCount };
};

/**
 * Scores a skill's relevance to a task using IDF-weighted field matching.
 *
 * @param entry - indexed skill (tokenized name/body/keywords)
 * @param taskWordSet - set of lowercase task keywords
 * @param idf - per-token IDF weights from {@link buildSkillIndex}
 * @returns relevance score (unbounded, non-negative float — compare only
 *   against other scores from the same index, never against a fixed
 *   constant)
 *
 * @remarks
 * `score = Σ_w idf(w) · (KEYWORD_FIELD_WEIGHT·[w∈keywords] + NAME_FIELD_WEIGHT·[w∈name] + BODY_FIELD_WEIGHT·[w∈body])`.
 *
 * Two changes from a plain field-weighted sum:
 * 1. **IDF weighting** — a task word that appears in every skill (e.g. a
 *    generic term used in every skill's preamble) contributes almost
 *    nothing; a word unique to one skill contributes heavily. Without this,
 *    a skill with a long `keywords` list wins largely by volume rather than
 *    by matching anything distinctive about the task.
 * 2. **Whole-body matching** — `bodyTokens` covers the entire skill content,
 *    not a fixed-length preview, so a match late in a long skill file still
 *    counts.
 *
 * O(k) per skill, where k = `taskWordSet.size` — each word is one O(1) Set
 * lookup per field, independent of skill name/body length.
 */
export const scoreSkillForTask = (
  entry: SkillIndexEntry,
  taskWordSet: ReadonlySet<string>,
  idf: ReadonlyMap<string, number>,
): number => {
  let score = 0;
  for (const word of taskWordSet) {
    const weight = idf.get(word);
    if (weight === undefined) {
      // Word appears in zero skills' docTokens, so it can't match any
      // field below regardless of weight — skip the (irrelevant) lookups.
      continue;
    }
    let fieldScore = 0;
    if (entry.keywordSet.has(word)) {
      fieldScore += KEYWORD_FIELD_WEIGHT;
    }
    if (entry.nameTokens.has(word)) {
      fieldScore += NAME_FIELD_WEIGHT;
    }
    if (entry.bodyTokens.has(word)) {
      fieldScore += BODY_FIELD_WEIGHT;
    }
    score += weight * fieldScore;
  }
  return score;
};
