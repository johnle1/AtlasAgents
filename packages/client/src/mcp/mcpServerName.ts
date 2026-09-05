/**
 * Validation and derivation for MCP server ids.
 *
 * @remarks
 * A server id is not just a config key — it is embedded verbatim into every
 * one of that server's model-facing tool names as `mcp__<id>__<tool>` (see
 * {@link "./mcpRegistry.js".namespaceToolName}). That puts three hard
 * constraints on it, none of which were previously enforced by `/mcp add`:
 *  - no `__`, or {@link "./mcpRegistry.js".parseNamespacedTool} splits the
 *    namespaced tool name in the wrong place;
 *  - only `[A-Za-z0-9_-]`, or the resulting tool name is rejected by the
 *    model API's tool-name pattern;
 *  - not `tokensave`, which is grandfathered to bare (non-namespaced) tool
 *    names and would otherwise collide.
 */

/** Ids that would collide with a built-in server. */
export const RESERVED_SERVER_IDS: ReadonlySet<string> = new Set(["tokensave"]);

/** Maximum length for a server id — generous, but bounded. */
const MAX_SERVER_ID_LENGTH = 40;

/** Only letters, digits, underscore, and hyphen are safe inside a namespaced tool name. */
const VALID_SERVER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Leading/only host labels that carry no identity, stripped by {@link deriveServerId}. */
const GENERIC_HOST_LABELS = new Set(["www", "mcp", "api", "server"]);

/** Result of validating a candidate server id. */
export type ServerIdValidation = { ok: true } | { ok: false; reason: string };

/**
 * Rejects any server id that would break tool naming.
 *
 * @remarks
 * Checked in a fixed order — empty, too long, contains `__`, invalid
 * characters, reserved — so the same bad input always produces the same
 * `reason`, making the failure message deterministic and easy to test.
 *
 * @param id - Candidate server id, as typed after `/mcp add`.
 * @returns `{ ok: true }`, or `{ ok: false, reason }` with a message ready
 *   to hand directly to `printError`.
 */
export const validateServerId = (id: string): ServerIdValidation => {
  if (id.length === 0) {
    return { ok: false, reason: "Server name cannot be empty." };
  }
  if (id.length > MAX_SERVER_ID_LENGTH) {
    return {
      ok: false,
      reason: `Server name "${id}" is too long (max ${MAX_SERVER_ID_LENGTH} characters).`,
    };
  }
  if (id.includes("__")) {
    return {
      ok: false,
      reason: `Server name "${id}" cannot contain "__" — it would break tool-name parsing (tools are namespaced as mcp__<name>__<tool>).`,
    };
  }
  if (!VALID_SERVER_ID_PATTERN.test(id)) {
    return {
      ok: false,
      reason: `Server name "${id}" may only contain letters, digits, "-", and "_".`,
    };
  }
  if (RESERVED_SERVER_IDS.has(id)) {
    return {
      ok: false,
      reason: `"${id}" is a reserved server name (built-in). Choose a different name.`,
    };
  }
  return { ok: true };
};

/** Replaces any character outside the valid set with "-", for use inside {@link deriveServerId}. */
const sanitizeLabel = (label: string): string =>
  label.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

/**
 * Derives a server id from a URL's hostname, de-duplicating against
 * `taken`.
 *
 * @remarks
 * Takes the hostname's labels, drops any leading label that's generic
 * (`mcp`, `api`, `www`, `server`) and the trailing TLD label, then uses the
 * first label left. Falls back to `"server"` if nothing distinctive
 * remains (e.g. a bare IP, or a host made up entirely of generic labels).
 *
 * @example
 * ```ts
 * deriveServerId("https://mcp.atlassian.com/v2/mcp", new Set()); // "atlassian"
 * deriveServerId("https://api.linear.app/mcp", new Set(["linear"])); // "linear-2"
 * ```
 */
export const deriveServerId = (url: string, taken: ReadonlySet<string>): string => {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = "server";
  }

  const labels = hostname.split(".").filter(Boolean);
  // Drop the trailing TLD label (if there's more than one label left after
  // that, it's still meaningful — e.g. "mcp.atlassian.com" -> ["mcp","atlassian"]).
  const withoutTld = labels.length > 1 ? labels.slice(0, -1) : labels;
  const meaningful = withoutTld.filter((label) => !GENERIC_HOST_LABELS.has(label));

  // Deliberately does NOT fall back to a generic label from `withoutTld`
  // when `meaningful` is empty (e.g. "mcp.api.com") — that would defeat the
  // whole point of filtering generic labels out. Falls straight to the
  // literal "server" instead.
  const candidateLabel = meaningful[0] ?? "server";
  let base = sanitizeLabel(candidateLabel).replace(/^-+|-+$/g, "");
  if (base.length === 0 || !VALID_SERVER_ID_PATTERN.test(base)) {
    base = "server";
  }

  if (!taken.has(base)) {
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
};
