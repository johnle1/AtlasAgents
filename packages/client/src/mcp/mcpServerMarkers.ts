/**
 * Content-based fingerprints for MCP server configs, and pin detection used
 * to decide how long a discovered tool list can be trusted.
 *
 * @remarks
 * Replaces the old `config.json`-mtime marker, which invalidated every
 * server's cached tools on ANY config write (`/model`, `/set retries`, …).
 * A marker here changes only when that specific server's connection
 * shape or credentials actually change.
 */

import { createHash } from "node:crypto";
import type { McpServerConfig } from "../config/types.js";

/** Recursively sorts object keys so structurally-equal values always serialize identically. */
export const canonicalStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** Content fingerprint for one server's connection config + credentials. */
export const computeServerMarker = (
  serverId: string,
  config: McpServerConfig,
  secrets: Record<string, string>,
): string =>
  createHash("sha256")
    .update(canonicalStringify({ serverId, config, secrets }))
    .digest("hex");

/**
 * Composite fingerprint sent to the server as `mcpMarker` — same wire shape
 * as before (one opaque string, compared by equality), derived differently:
 * it changes if and only if the enabled server set, or any one of their
 * configs/secrets, actually changed.
 */
export const computeRootMarker = (leaves: Record<string, string>): string => {
  const sorted = Object.keys(leaves)
    .sort()
    .map((id) => `${id}=${leaves[id]}`)
    .join("|");
  return createHash("sha256").update(sorted).digest("hex");
};

/** Runner subcommands that precede the package spec, not part of it. */
const RUNNER_SUBCOMMANDS = new Set(["dlx", "exec", "x"]);

/**
 * Whether `config` names an immutable, version-pinned package reference.
 *
 * @remarks
 * Mirrors how Docker/Kubernetes treat image references: a pinned tag or
 * digest is trusted indefinitely (`imagePullPolicy: IfNotPresent`), while a
 * floating reference like `:latest` is never trusted
 * (`imagePullPolicy: Always`) because it can point to different content on
 * every pull. `npx -y pkg` (no version) is the `:latest` case here — it
 * resolves to the newest publish on every spawn.
 *
 * Deliberately biased toward `false`: only a positively recognized pin earns
 * "never expire" treatment, so a misdetection costs a little re-discovery
 * time, never correctness.
 */
export const isVersionPinned = (config: McpServerConfig): boolean => {
  if (config.transport !== "stdio") {
    return false;
  }
  const spec = (config.args ?? []).find(
    (arg) => !arg.startsWith("-") && !RUNNER_SUBCOMMANDS.has(arg),
  );
  if (!spec) {
    return false;
  }
  // npm-style: name@1.2.3 or @scope/name@1.2.3 — the LAST "@", so a scope's
  // own leading "@" isn't mistaken for the version separator. A dist-tag
  // (@latest, @next, @beta) is not a pin — only a numeric version is.
  const lastAt = spec.lastIndexOf("@");
  if (lastAt > 0 && /^\d+(\.\d+){1,2}/.test(spec.slice(lastAt + 1))) {
    return true;
  }
  // Python-style: pkg==1.2.3
  if (/==\d+(\.\d+){0,2}/.test(spec)) {
    return true;
  }
  return false;
};
