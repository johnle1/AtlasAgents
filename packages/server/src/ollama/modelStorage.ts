/**
 * Reads Ollama's on-disk model directory directly (manifests + blobs) to
 * report real disk usage — what `models.list`'s per-tag "Size" cannot show.
 *
 * @remarks
 * Ollama content-addresses model layers by SHA-256 digest: a manifest at
 * `<dir>/manifests/<registry>/<namespace>/<model>/<tag>` is a small JSON file
 * listing `config` + `layers` digests, each of which maps to a blob file at
 * `<dir>/blobs/sha256-<hex>` (colon replaced with a dash). Two tags that
 * share layers (e.g. `gemma3:12b` and `gemma3:latest` built from the same
 * weights) reference the same blob files — deleting one tag's manifest frees
 * nothing if every blob it names is still referenced by the other.
 *
 * Interrupted pulls leave `sha256-<hex>-partial` blob files that no manifest
 * ever references (a manifest is only written once a pull completes) — they
 * are invisible to `GET /api/tags` and untouched by `DELETE /api/delete`.
 * This module is the only thing in the codebase that can see them.
 *
 * This is a **read-only** filesystem scan. Nothing here writes or deletes
 * anything — callers render the results and let the user run `rm -rf`
 * themselves on whatever they decide to clean up.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ModelStorageOrphan,
  ModelStorageReport,
  ModelStorageRow,
} from "@loopycode/shared";

/** Where `resolveModelsDir` found the directory, for display in the report. */
export type ModelsDirSource =
  | "env:OLLAMA_MODELS"
  | "default:~/.ollama/models"
  | "default:/usr/share/ollama/.ollama/models"
  | "default:/var/lib/ollama/.ollama/models";

/** Result of locating Ollama's model directory on this filesystem. */
export type ResolvedModelsDir = {
  /** Absolute path to the candidate directory. */
  path: string;

  /** Which candidate rule produced {@link path}, for the report's display line. */
  source: ModelsDirSource;

  /**
   * Whether `<path>/manifests` was confirmed to exist and be listable.
   *
   * @remarks
   * `false` means the directory either doesn't exist or isn't readable by
   * this process (e.g. Ollama runs as a dedicated service user) — the path
   * is still returned so the report can tell the user what was tried.
   */
  readable: boolean;
};

const isErrnoException = (err: unknown): err is NodeJS.ErrnoException =>
  err instanceof Error && "code" in err;

/**
 * Locates Ollama's model directory by checking, in order: the `OLLAMA_MODELS`
 * env var, then the default install locations for a user-run install (macOS,
 * most Linux desktop installs) and the two common systemd-service locations.
 *
 * @remarks
 * The first candidate whose `manifests/` subdirectory can be listed wins. A
 * candidate that exists but isn't readable (`EACCES`) is returned immediately
 * — rather than silently falling through to the next guess — since a
 * permission-restricted directory is still *the* directory on this host; a
 * wrong guess would be more misleading than an honest "found it, can't read
 * it". A missing candidate (`ENOENT`) falls through to the next one.
 *
 * @returns The resolved directory, its source, and whether it's readable.
 *   Never throws — an unresolvable host falls back to the default path with
 *   `readable: false` so the caller always has something concrete to show.
 */
export const resolveModelsDir = async (): Promise<ResolvedModelsDir> => {
  const envPath = process.env.OLLAMA_MODELS;
  const candidates: Array<{ source: ModelsDirSource; dirPath: string }> = [
    ...(envPath ? [{ source: "env:OLLAMA_MODELS" as const, dirPath: envPath }] : []),
    {
      source: "default:~/.ollama/models",
      dirPath: path.join(os.homedir(), ".ollama", "models"),
    },
    {
      source: "default:/usr/share/ollama/.ollama/models",
      dirPath: "/usr/share/ollama/.ollama/models",
    },
    {
      source: "default:/var/lib/ollama/.ollama/models",
      dirPath: "/var/lib/ollama/.ollama/models",
    },
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(path.join(candidate.dirPath, "manifests"));
      if (stat.isDirectory()) {
        return { path: candidate.dirPath, source: candidate.source, readable: true };
      }
    } catch (err) {
      if (isErrnoException(err) && err.code === "EACCES") {
        return { path: candidate.dirPath, source: candidate.source, readable: false };
      }
      // ENOENT (or any other lookup failure) — try the next candidate.
    }
  }

  const fallbackPath = path.join(os.homedir(), ".ollama", "models");
  return { path: fallbackPath, source: "default:~/.ollama/models", readable: false };
};

/** One layer/config reference inside an Ollama manifest JSON file. */
type ManifestRef = { digest: string; size?: number };

/** Shape of an Ollama manifest file — only the fields this scan reads. */
type OllamaManifest = { config?: ManifestRef; layers?: ManifestRef[] };

/** `"sha256:<hex>"` → `"sha256-<hex>"`, the on-disk blob filename. */
const blobFilenameFromDigest = (digest: string): string => digest.replace(":", "-");

/**
 * Recursively lists every regular file under `root`, tolerating unreadable
 * subdirectories by skipping them rather than failing the whole walk.
 */
const walkFiles = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }
  return out;
};

/**
 * Derives the display tag name (e.g. `"gemma3:12b"`, `"myuser/model:latest"`)
 * from a manifest file's path relative to the `manifests/` root.
 *
 * @remarks
 * Ollama lays manifests out as `<registry>/<namespace>/<model>/<tag>`. The
 * `library` namespace is Ollama's default/official one and is never shown
 * (matching `ollama list`'s own display convention) — any other namespace is
 * kept as a `<namespace>/<model>:<tag>` prefix.
 */
const tagNameFromManifestPath = (
  manifestsRoot: string,
  manifestPath: string,
): string => {
  const relative = path.relative(manifestsRoot, manifestPath);
  const parts = relative.split(path.sep);
  if (parts.length < 2) {
    return relative;
  }
  const tag = parts[parts.length - 1]!;
  const model = parts[parts.length - 2]!;
  const namespace = parts.length >= 3 ? parts[parts.length - 3] : undefined;
  const modelWithTag = `${model}:${tag}`;
  return namespace && namespace !== "library"
    ? `${namespace}/${modelWithTag}`
    : modelWithTag;
};

/** Full result of scanning one Ollama model directory. */
export type ModelStorageScanResult = {
  dir: string;
  models: ModelStorageRow[];
  orphans: ModelStorageOrphan[];
  totals: { onDiskBytes: number; referencedBytes: number; orphanedBytes: number };
  /** Manifest files that failed to parse or had no recognizable digests — counted, not surfaced per-file. */
  skippedManifests: number;
};

/**
 * Scans an Ollama model directory's `manifests/` and `blobs/` subdirectories
 * to compute real per-tag disk usage, distinguishing blobs unique to one tag
 * from blobs shared with others, plus any orphaned (unreferenced) blob files.
 *
 * @remarks
 * Blob sizes are always read from the actual file on disk via `fs.stat`,
 * never trusted from the manifest's declared `size` — the manifest can only
 * describe what a *complete* pull should contain, not what's actually there.
 * A malformed or unreadable individual manifest is skipped (counted in
 * `skippedManifests`) rather than failing the whole scan; only a fully
 * unreadable `manifests/` or `blobs/` directory (e.g. permissions) degrades
 * to empty results, since {@link resolveModelsDir} is expected to have
 * already confirmed `manifests/` exists and is listable before this runs.
 *
 * @param dir - Path previously returned by {@link resolveModelsDir}.
 * @returns Per-tag rows (largest first), orphaned blobs (largest first), and
 *   aggregate totals.
 *
 * @example
 * ```ts
 * const { path: dir } = await resolveModelsDir();
 * const { models, orphans, totals } = await scanModelStorage(dir);
 * console.log(`${totals.orphanedBytes} bytes orphaned across ${orphans.length} files`);
 * ```
 */
export const scanModelStorage = async (dir: string): Promise<ModelStorageScanResult> => {
  const manifestsRoot = path.join(dir, "manifests");
  const blobsRoot = path.join(dir, "blobs");

  const manifestFiles = await walkFiles(manifestsRoot);

  // blob filename -> tag names that reference it (refcount for unique/shared split)
  const tagsByBlob = new Map<string, Set<string>>();
  // tag name -> the (deduped) blob filenames it references
  const blobsByTag = new Map<string, string[]>();
  let skippedManifests = 0;

  for (const manifestPath of manifestFiles) {
    try {
      const raw = await fs.readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as OllamaManifest;
      const refs = [
        ...(parsed.config ? [parsed.config] : []),
        ...(Array.isArray(parsed.layers) ? parsed.layers : []),
      ].filter((ref): ref is ManifestRef => typeof ref?.digest === "string");

      if (refs.length === 0) {
        skippedManifests += 1;
        continue;
      }

      const tagName = tagNameFromManifestPath(manifestsRoot, manifestPath);
      const blobFilenames = [...new Set(refs.map((ref) => blobFilenameFromDigest(ref.digest)))];
      blobsByTag.set(tagName, blobFilenames);

      for (const blobFilename of blobFilenames) {
        let tags = tagsByBlob.get(blobFilename);
        if (!tags) {
          tags = new Set();
          tagsByBlob.set(blobFilename, tags);
        }
        tags.add(tagName);
      }
    } catch {
      skippedManifests += 1;
    }
  }

  let blobEntries: string[] = [];
  try {
    blobEntries = await fs.readdir(blobsRoot);
  } catch {
    blobEntries = [];
  }

  const blobSizeByFilename = new Map<string, number>();
  for (const entry of blobEntries) {
    try {
      const stat = await fs.stat(path.join(blobsRoot, entry));
      blobSizeByFilename.set(entry, stat.size);
    } catch {
      // Vanished or unreadable between readdir and stat — treat as absent.
    }
  }

  const models: ModelStorageRow[] = [];
  for (const [tagName, blobFilenames] of blobsByTag) {
    let uniqueBytes = 0;
    let sharedBytes = 0;
    let totalBytes = 0;
    const sharedWith = new Set<string>();

    for (const blobFilename of blobFilenames) {
      const size = blobSizeByFilename.get(blobFilename) ?? 0;
      totalBytes += size;
      const tags = tagsByBlob.get(blobFilename) ?? new Set([tagName]);
      if (tags.size > 1) {
        sharedBytes += size;
        for (const otherTag of tags) {
          if (otherTag !== tagName) {
            sharedWith.add(otherTag);
          }
        }
      } else {
        uniqueBytes += size;
      }
    }

    models.push({
      tag: tagName,
      totalBytes,
      uniqueBytes,
      sharedBytes,
      sharedWith: [...sharedWith].sort(),
    });
  }
  models.sort((a, b) => b.totalBytes - a.totalBytes);

  const referencedBlobFilenames = new Set(tagsByBlob.keys());
  const orphans: ModelStorageOrphan[] = blobEntries
    .filter((entry) => !referencedBlobFilenames.has(entry))
    .map((entry) => ({
      path: path.join(blobsRoot, entry),
      bytes: blobSizeByFilename.get(entry) ?? 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const referencedBytes = [...tagsByBlob.keys()].reduce(
    (sum, blobFilename) => sum + (blobSizeByFilename.get(blobFilename) ?? 0),
    0,
  );
  const orphanedBytes = orphans.reduce((sum, orphan) => sum + orphan.bytes, 0);

  return {
    dir,
    models,
    orphans,
    totals: {
      onDiskBytes: referencedBytes + orphanedBytes,
      referencedBytes,
      orphanedBytes,
    },
    skippedManifests,
  };
};

/**
 * Whether an Ollama base URL points at this machine.
 *
 * @remarks
 * `scanModelStorage` reads the local filesystem — if Ollama is actually
 * running on a different host, the local scan would (at best) find nothing,
 * or (at worst) describe an unrelated local Ollama install as if it were the
 * remote one's storage. Callers should skip the scan and say so instead.
 *
 * @param baseUrl - The configured Ollama base URL, e.g. `"http://localhost:11434"`.
 * @returns `true` for `localhost`/`127.0.0.1`/`::1`, or when `baseUrl` fails
 *   to parse (fail open — most misconfigured values are typos of a local URL,
 *   not evidence of a remote one).
 */
export const isLocalOllamaHost = (baseUrl: string): boolean => {
  try {
    const { hostname } = new URL(baseUrl);
    // URL lowercases the hostname but keeps IPv6 literals bracketed
    // (`"[::1]"`), unlike a bare IPv4 hostname — strip the brackets before comparing.
    const unbracketed = hostname.replace(/^\[|\]$/g, "");
    return (
      unbracketed === "localhost" || unbracketed === "127.0.0.1" || unbracketed === "::1"
    );
  } catch {
    return true;
  }
};

/**
 * Produces a full {@link ModelStorageReport}: resolves the model directory,
 * checks it's local and readable, and scans it — or explains why not.
 *
 * @param ollamaBaseUrl - The Ollama base URL this server is configured
 *   against. Omitted / undefined is treated as local (the common single-host
 *   default), matching how the rest of the codebase treats an unset base URL.
 *
 * @example
 * ```ts
 * const report = await buildModelStorageReport("http://localhost:11434");
 * if (report.available) {
 *   console.log(`${report.totals.orphanedBytes} orphaned bytes in ${report.dir}`);
 * } else {
 *   console.log(report.reason);
 * }
 * ```
 */
export const buildModelStorageReport = async (
  ollamaBaseUrl: string | undefined,
): Promise<ModelStorageReport> => {
  if (ollamaBaseUrl !== undefined && !isLocalOllamaHost(ollamaBaseUrl)) {
    return {
      available: false,
      reason:
        "Ollama is running on a remote host — its model directory isn't on this server's filesystem.",
    };
  }

  const resolved = await resolveModelsDir();
  if (!resolved.readable) {
    return {
      available: false,
      reason: `Could not read an Ollama model directory (last tried: ${resolved.path}). Set OLLAMA_MODELS if Ollama uses a non-default location.`,
    };
  }

  const scan = await scanModelStorage(resolved.path);
  return {
    available: true,
    dir: scan.dir,
    dirSource: resolved.source,
    models: scan.models,
    orphans: scan.orphans,
    totals: scan.totals,
  };
};
