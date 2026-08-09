/**
 * Unit tests — server ollama/modelStorage.ts
 *
 * `scanModelStorage` and `resolveModelsDir` do real filesystem I/O against
 * temp-directory fixtures (no network, no real Ollama) — this is a thin
 * wrapper around `fs`, so faking `fs` itself would just re-describe the
 * implementation. `os.homedir()` is mocked so `resolveModelsDir`'s default
 * candidate can be pointed at a fixture without touching the real home dir.
 *
 * Category checklist:
 * - Normal: shared vs. unique blob accounting, namespaced tags, orphan detection
 * - Boundary: malformed/empty manifests skipped and counted, empty directory,
 *   EACCES on a found-but-unreadable directory, candidate precedence
 * - Error: missing manifests/blobs dirs never throw
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const mockHomedir = vi.hoisted(() => ({ value: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomedir.value };
});

const {
  resolveModelsDir,
  scanModelStorage,
  isLocalOllamaHost,
  buildModelStorageReport,
} = await import("../../../../packages/server/src/ollama/modelStorage.js");

const tempRoots: string[] = [];

const mkTempDir = async (prefix: string): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  delete process.env.OLLAMA_MODELS;
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

/** Writes a fake blob file (content doesn't need to hash to its digest). */
const writeBlob = async (blobsDir: string, filename: string, bytes: number): Promise<void> => {
  await fs.writeFile(path.join(blobsDir, filename), Buffer.alloc(bytes, 1));
};

/** Writes a manifest JSON file at `manifests/<registry>/<namespace>/<model>/<tag>`. */
const writeManifest = async (
  manifestsDir: string,
  registry: string,
  namespace: string,
  model: string,
  tag: string,
  content: unknown,
): Promise<void> => {
  const dir = path.join(manifestsDir, registry, namespace, model);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, tag),
    typeof content === "string" ? content : JSON.stringify(content),
  );
};

describe("scanModelStorage", () => {
  it("splits shared vs. unique blob bytes across two tags sharing one blob (normal)", async () => {
    const root = await mkTempDir("loopy-model-storage-");
    const manifestsDir = path.join(root, "manifests");
    const blobsDir = path.join(root, "blobs");
    await fs.mkdir(blobsDir, { recursive: true });

    await writeBlob(blobsDir, "sha256-shared", 1000);
    await writeBlob(blobsDir, "sha256-uniquea", 500);
    await writeBlob(blobsDir, "sha256-uniqueb", 700);

    await writeManifest(manifestsDir, "registry.ollama.ai", "library", "gemma3", "12b", {
      config: { digest: "sha256:shared", size: 1000 },
      layers: [{ digest: "sha256:uniquea", size: 500 }],
    });
    await writeManifest(manifestsDir, "registry.ollama.ai", "library", "gemma3", "latest", {
      config: { digest: "sha256:shared", size: 1000 },
      layers: [{ digest: "sha256:uniqueb", size: 700 }],
    });

    const result = await scanModelStorage(root);

    const byTag = new Map(result.models.map((m) => [m.tag, m]));
    expect(byTag.get("gemma3:12b")).toEqual({
      tag: "gemma3:12b",
      totalBytes: 1500,
      uniqueBytes: 500,
      sharedBytes: 1000,
      sharedWith: ["gemma3:latest"],
    });
    expect(byTag.get("gemma3:latest")).toEqual({
      tag: "gemma3:latest",
      totalBytes: 1700,
      uniqueBytes: 700,
      sharedBytes: 1000,
      sharedWith: ["gemma3:12b"],
    });
    expect(result.totals.referencedBytes).toBe(2200); // shared counted once
    expect(result.totals.orphanedBytes).toBe(0);
    expect(result.orphans).toEqual([]);
  });

  it("prefixes a non-library namespace and leaves library unprefixed (normal)", async () => {
    const root = await mkTempDir("loopy-model-storage-");
    const manifestsDir = path.join(root, "manifests");
    const blobsDir = path.join(root, "blobs");
    await fs.mkdir(blobsDir, { recursive: true });
    await writeBlob(blobsDir, "sha256-custom", 100);
    await writeManifest(manifestsDir, "registry.ollama.ai", "myuser", "custommodel", "latest", {
      config: { digest: "sha256:custom", size: 100 },
      layers: [],
    });

    const result = await scanModelStorage(root);
    expect(result.models.map((m) => m.tag)).toEqual(["myuser/custommodel:latest"]);
  });

  it("finds orphaned blobs, including interrupted-pull -partial files (normal — the headline scenario)", async () => {
    const root = await mkTempDir("loopy-model-storage-");
    const manifestsDir = path.join(root, "manifests");
    const blobsDir = path.join(root, "blobs");
    await fs.mkdir(blobsDir, { recursive: true });

    await writeBlob(blobsDir, "sha256-referenced", 100);
    await writeBlob(blobsDir, "sha256-abc123-partial", 6_000);
    await writeBlob(blobsDir, "sha256-unreferenced", 200);

    await writeManifest(manifestsDir, "registry.ollama.ai", "library", "gemma3", "12b", {
      config: { digest: "sha256:referenced", size: 100 },
      layers: [],
    });

    const result = await scanModelStorage(root);

    expect(result.orphans).toHaveLength(2);
    const orphanBytes = result.orphans.map((o) => o.bytes).sort((a, b) => a - b);
    expect(orphanBytes).toEqual([200, 6_000]);
    expect(result.orphans.some((o) => o.path.endsWith("-partial"))).toBe(true);
    expect(result.totals.orphanedBytes).toBe(6_200);
    expect(result.totals.onDiskBytes).toBe(6_300);
  });

  it("skips a malformed (invalid JSON) manifest and counts it, without failing the scan (boundary)", async () => {
    const root = await mkTempDir("loopy-model-storage-");
    const manifestsDir = path.join(root, "manifests");
    const blobsDir = path.join(root, "blobs");
    await fs.mkdir(blobsDir, { recursive: true });
    await writeBlob(blobsDir, "sha256-good", 100);

    await writeManifest(manifestsDir, "registry.ollama.ai", "library", "broken", "latest", "{ not json");
    await writeManifest(manifestsDir, "registry.ollama.ai", "library", "good", "latest", {
      config: { digest: "sha256:good", size: 100 },
      layers: [],
    });

    const result = await scanModelStorage(root);
    expect(result.skippedManifests).toBe(1);
    expect(result.models.map((m) => m.tag)).toEqual(["good:latest"]);
  });

  it("skips a manifest with no recognizable digests (boundary)", async () => {
    const root = await mkTempDir("loopy-model-storage-");
    const manifestsDir = path.join(root, "manifests");
    await fs.mkdir(path.join(root, "blobs"), { recursive: true });
    await writeManifest(manifestsDir, "registry.ollama.ai", "library", "empty", "latest", {});

    const result = await scanModelStorage(root);
    expect(result.skippedManifests).toBe(1);
    expect(result.models).toEqual([]);
  });

  it("returns empty results (never throws) when manifests/ and blobs/ don't exist (error)", async () => {
    const root = await mkTempDir("loopy-model-storage-");

    const result = await scanModelStorage(root);
    expect(result.models).toEqual([]);
    expect(result.orphans).toEqual([]);
    expect(result.totals).toEqual({ onDiskBytes: 0, referencedBytes: 0, orphanedBytes: 0 });
  });

  it("de-duplicates a manifest referencing the same digest in config and layers (boundary)", async () => {
    const root = await mkTempDir("loopy-model-storage-");
    const manifestsDir = path.join(root, "manifests");
    const blobsDir = path.join(root, "blobs");
    await fs.mkdir(blobsDir, { recursive: true });
    await writeBlob(blobsDir, "sha256-dup", 100);
    await writeManifest(manifestsDir, "registry.ollama.ai", "library", "dupmodel", "latest", {
      config: { digest: "sha256:dup", size: 100 },
      layers: [{ digest: "sha256:dup", size: 100 }],
    });

    const result = await scanModelStorage(root);
    // Counted once, not twice, despite appearing in both config and layers.
    expect(result.models[0]?.totalBytes).toBe(100);
  });
});

describe("resolveModelsDir", () => {
  beforeEach(() => {
    mockHomedir.value = "";
  });

  it("prefers OLLAMA_MODELS when its manifests/ subdirectory exists (normal)", async () => {
    const envDir = await mkTempDir("loopy-model-storage-env-");
    await fs.mkdir(path.join(envDir, "manifests"), { recursive: true });
    process.env.OLLAMA_MODELS = envDir;

    const result = await resolveModelsDir();
    expect(result).toEqual({ path: envDir, source: "env:OLLAMA_MODELS", readable: true });
  });

  it("falls through to ~/.ollama/models when OLLAMA_MODELS is unset (normal)", async () => {
    const homeDir = await mkTempDir("loopy-model-storage-home-");
    await fs.mkdir(path.join(homeDir, ".ollama", "models", "manifests"), { recursive: true });
    mockHomedir.value = homeDir;

    const result = await resolveModelsDir();
    expect(result).toEqual({
      path: path.join(homeDir, ".ollama", "models"),
      source: "default:~/.ollama/models",
      readable: true,
    });
  });

  it("falls through to the next candidate when OLLAMA_MODELS points nowhere real (boundary — ENOENT)", async () => {
    process.env.OLLAMA_MODELS = path.join(os.tmpdir(), "loopy-does-not-exist-xyz");
    const homeDir = await mkTempDir("loopy-model-storage-home-");
    await fs.mkdir(path.join(homeDir, ".ollama", "models", "manifests"), { recursive: true });
    mockHomedir.value = homeDir;

    const result = await resolveModelsDir();
    expect(result.source).toBe("default:~/.ollama/models");
    expect(result.readable).toBe(true);
  });

  it("reports readable: false for a candidate that exists but can't be read, without falling through (boundary — EACCES)", async () => {
    // Root bypasses filesystem permission checks entirely, which would make
    // this assertion flaky under a root-run test process — skip there.
    if (process.getuid && process.getuid() === 0) {
      return;
    }
    const homeDir = await mkTempDir("loopy-model-storage-home-");
    const restrictedModels = path.join(homeDir, ".ollama", "models");
    await fs.mkdir(restrictedModels, { recursive: true });
    await fs.chmod(restrictedModels, 0o000);
    mockHomedir.value = homeDir;

    try {
      const result = await resolveModelsDir();
      expect(result).toEqual({
        path: restrictedModels,
        source: "default:~/.ollama/models",
        readable: false,
      });
    } finally {
      await fs.chmod(restrictedModels, 0o755);
    }
  });
});

describe("isLocalOllamaHost", () => {
  it("treats localhost, 127.0.0.1, and ::1 as local (normal)", () => {
    expect(isLocalOllamaHost("http://localhost:11434")).toBe(true);
    expect(isLocalOllamaHost("http://127.0.0.1:11434")).toBe(true);
    expect(isLocalOllamaHost("http://[::1]:11434")).toBe(true);
  });

  it("treats another host as remote (normal)", () => {
    expect(isLocalOllamaHost("http://gpu-box.internal:11434")).toBe(false);
    expect(isLocalOllamaHost("http://10.0.0.7:11434")).toBe(false);
  });

  it("fails open to local on an unparseable URL (boundary)", () => {
    expect(isLocalOllamaHost("not-a-url")).toBe(true);
  });
});

describe("buildModelStorageReport", () => {
  beforeEach(() => {
    mockHomedir.value = "";
  });

  it("reports unavailable for a remote Ollama host without scanning the local filesystem (normal)", async () => {
    const report = await buildModelStorageReport("http://gpu-box.internal:11434");
    expect(report.available).toBe(false);
    if (!report.available) {
      expect(report.reason).toContain("remote");
    }
  });

  it("reports unavailable with a helpful reason when the directory can't be found (boundary)", async () => {
    mockHomedir.value = path.join(os.tmpdir(), "loopy-nonexistent-home-xyz");
    const report = await buildModelStorageReport("http://localhost:11434");
    expect(report.available).toBe(false);
    if (!report.available) {
      expect(report.reason).toContain("OLLAMA_MODELS");
    }
  });

  it("scans and reports totals for a local, readable directory (normal)", async () => {
    const homeDir = await mkTempDir("loopy-model-storage-home-");
    const modelsDir = path.join(homeDir, ".ollama", "models");
    await fs.mkdir(path.join(modelsDir, "blobs"), { recursive: true });
    await writeBlob(path.join(modelsDir, "blobs"), "sha256-a", 100);
    await writeManifest(
      path.join(modelsDir, "manifests"),
      "registry.ollama.ai",
      "library",
      "gemma3",
      "12b",
      { config: { digest: "sha256:a", size: 100 }, layers: [] },
    );
    mockHomedir.value = homeDir;

    const report = await buildModelStorageReport("http://localhost:11434");
    expect(report.available).toBe(true);
    if (report.available) {
      expect(report.models).toHaveLength(1);
      expect(report.totals.referencedBytes).toBe(100);
      expect(report.dirSource).toBe("default:~/.ollama/models");
    }
  });

  it("treats an undefined base URL as local (boundary)", async () => {
    const homeDir = await mkTempDir("loopy-model-storage-home-");
    await fs.mkdir(path.join(homeDir, ".ollama", "models", "manifests"), { recursive: true });
    mockHomedir.value = homeDir;

    const report = await buildModelStorageReport(undefined);
    expect(report.available).toBe(true);
  });
});
