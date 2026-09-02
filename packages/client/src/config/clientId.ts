/**
 * A random, locally-generated identifier for this installation.
 *
 * @remarks
 * Used to disambiguate MCP tool-sync cache entries on the server (see
 * `mcp/mcpToolsCache.ts` and the server's `McpToolsCacheStore`) — the server
 * supports multiple different clients sharing one instance with no per-user
 * auth identity, so a cache keyed only by workspace path could serve one
 * client another client's cached tools if they happened to report the same
 * workspace. This is not a security credential — just a stable value that
 * makes two different installations distinguishable, generated once on
 * first use and persisted so it stays the same across restarts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_DIR, ensureDirs } from "./index.js";

const CLIENT_ID_FILE = path.join(CONFIG_DIR, "clientId");

let cached: string | undefined;

/**
 * Returns this installation's persisted client id, generating and saving
 * one on first call if none exists yet.
 */
export const getClientId = (): string => {
  if (cached) {
    return cached;
  }
  try {
    const existing = fs.readFileSync(CLIENT_ID_FILE, "utf-8").trim();
    if (existing.length > 0) {
      cached = existing;
      return cached;
    }
  } catch {
    // No file yet — fall through and generate one.
  }
  const generated = randomUUID();
  ensureDirs();
  fs.writeFileSync(CLIENT_ID_FILE, generated, { encoding: "utf-8" });
  cached = generated;
  return generated;
};
