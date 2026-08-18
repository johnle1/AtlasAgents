/**
 * Wire shape for a `models.storage` response — a read-only report of what
 * Ollama's on-disk model directory actually contains, distinct from
 * `models.list`'s per-tag view.
 *
 * @remarks
 * `models.list` reports each installed tag's advertised size as if it were
 * independently owned disk space. It isn't: Ollama content-addresses model
 * layers by digest, so two tags that share layers (e.g. `gemma3:12b` and
 * `gemma3:latest` pointing at the same weights) only occupy that space once.
 * Deleting one such tag frees nothing. `models.storage` exists to make that
 * visible — per-tag unique vs. shared bytes, plus blob files an interrupted
 * `/models pull` left behind that no tag references at all (and that
 * `/models delete` therefore can never reach).
 */

/** One installed model tag's disk accounting. */
export interface ModelStorageRow {
  /** Display tag name (e.g. `"gemma3:12b"`, `"myuser/custommodel:latest"`). */
  tag: string;

  /** Total bytes across every blob this tag references. */
  totalBytes: number;

  /** Bytes referenced only by this tag — what deleting it would actually free. */
  uniqueBytes: number;

  /** Bytes referenced by this tag and at least one other installed tag. */
  sharedBytes: number;

  /** Other installed tags this one shares at least one blob with. */
  sharedWith: string[];
}

/** A blob file on disk that no installed tag's manifest references. */
export interface ModelStorageOrphan {
  /** Absolute path to the orphaned blob file. */
  path: string;

  /** File size in bytes. */
  bytes: number;
}

/** Aggregate byte counts across the whole scanned model directory. */
export interface ModelStorageTotals {
  /** Every blob byte on disk — referenced plus orphaned. */
  onDiskBytes: number;

  /** Bytes referenced by at least one installed tag's manifest. */
  referencedBytes: number;

  /** Bytes in blob files no manifest references. */
  orphanedBytes: number;
}

/**
 * Full `models.storage` response.
 *
 * @remarks
 * `available: false` covers every reason the report couldn't be produced —
 * the directory isn't readable (permissions, wrong path guess), or Ollama is
 * running on a different host than this server — with `reason` explaining
 * which. Consumers should treat a `false` report as "unknown", not "empty".
 */
export type ModelStorageReport =
  | {
      available: true;
      dir: string;
      dirSource: string;
      models: ModelStorageRow[];
      orphans: ModelStorageOrphan[];
      totals: ModelStorageTotals;
    }
  | {
      available: false;
      reason: string;
    };
