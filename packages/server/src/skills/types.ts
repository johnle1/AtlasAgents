/**
 * TypeScript type definitions for the skills system.
 *
 * @remarks
 * Defines the shapes used throughout skill management: metadata (stacks, keywords),
 * loaded skill objects (with parsed content and metadata), and the skill index
 * (mapping stacks to skills and collecting domain-level skills).
 */

/**
 * Defines the shape of metadata parsed from a skill document, including stack and keyword tags.
 *
 * @remarks
 * - normaliseSkillMeta — constructs valid metadata objects.
 * - parseSkillMetaJson — parses JSON text.
 * - parseSkillDocument — merges sidecar and inline metadata.
 */
export type SkillMeta = {
  /** Target technology stacks/frameworks associated with this skill. */
  stacks: string[];

  /** Whether this skill represents a general domain skill rather than a stack-specific one. */
  domain: boolean;

  /** Priority score used to resolve conflicts when multiple skills match the same stack. */
  priority: number;

  /** Keywords used to compute task relevance scores for matching. */
  keywords: string[];
};

/**
 * Represents a fully parsed skill including its name, raw body content, and metadata.
 *
 * @remarks
 * - readSkillFromDir — reads, parses, and loads skill files from disk.
 */
export type LoadedSkill = {
  /** The unique name of the skill file (basename without extension). */
  name: string;

  /** The cleaned markdown content body after removing inline metadata blocks. */
  content: string;

  /** The parsed and merged metadata. */
  meta: SkillMeta;
};

/**
 * Defines the shape of the resolved index of loaded skills.
 *
 * @remarks
 * - buildSkillIndex — creates index mapping from loaded skills.
 */
export type SkillIndex = {
  /**
   * Stack id from exploration map to skill name (highest priority wins).
   * Maps stack names (e.g. "python", "javascript") to the primary matching skill name.
   */
  stackToSkill: Map<string, string>;

  /**
   * Set of names of skills that are flagged as general domain-level skills.
   */
  domainSkillNames: Set<string>;
};
