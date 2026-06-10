import type { RSocket } from "@rsocket/core";
import type { Config } from "../config.js";

/**
 * <Summary>
 * What it does:
 *   Builds the metadata Buffer containing the password, attached to every
 *   RSocket frame so the server can authenticate each request.
 *
 * How it does it (step by step):
 *   1. Reads password from config (defaults to empty string).
 *   2. Wraps it in a JSON object { password: "..." }.
 *   3. Serialises to a UTF-8 Buffer.
 *
 * Parameters:
 *   @param {Config} config — The configuration object containing the password.
 *
 * Returns:
 *   @returns {Buffer} — UTF-8 JSON Buffer e.g. {"password":"..."}.
 *
 * Dependencies:
 *   None (uses Buffer.from).
 *
 * Dependants:
 *   - Connection.sendCommand — attaches this as metadata on requestResponse.
 *   - Connection.sendTask — attaches this as metadata on requestStream.
 * </Summary>
 */
export function authMetadata(config: Config): Buffer {
  // ===== STEP 1: Extract Password from Config =====
  // Step 1a: Read password from config (defaults to empty string if not set)
  // Step 1b: This password is validated by the server on every RSocket frame
  const password = config.password ?? "";

  // ===== STEP 2: Wrap in Auth Envelope =====
  // Step 2a: Create JSON object with password field for server authentication
  const authEnvelope = { password };

  // ===== STEP 3: Serialize to UTF-8 Buffer =====
  // Step 3a: Convert auth envelope to JSON string
  // Step 3b: Encode JSON as UTF-8 bytes in a Buffer for RSocket transmission
  return Buffer.from(JSON.stringify(authEnvelope), "utf-8");
}

/**
 * <Summary>
 * What it does:
 *   Returns the live RSocket instance or throws if not connected.
 *
 * How it does it (step by step):
 *   1. Checks if the RSocket instance is null.
 *   2. Throws an Error if null.
 *   3. Returns the RSocket instance if not null.
 *
 * Parameters:
 *   @param {RSocket | null} rsocket — The RSocket connection instance.
 *
 * Returns:
 *   @returns {RSocket} — The live RSocket connection object.
 *
 * @throws {Error} — When the connection is not established.
 *
 * Dependencies:
 *   None.
 *
 * Dependants:
 *   - Connection.sendCommand — calls after waitUntilConnected.
 *   - Connection.sendTask — calls after waitUntilConnected.
 * </Summary>
 */
export function requireSocket(rsocket: RSocket | null): RSocket {
  // ===== STEP 1: Validate Connection Exists =====
  // Step 1a: Check if the RSocket instance is currently set (null means disconnected)
  if (!rsocket) {
    // Step 1b: No connection available; throw to alert caller
    throw new Error("RSocket is not connected");
  }

  // ===== STEP 2: Return Live RSocket =====
  // Step 2a: Connection verified; return the RSocket instance for use
  return rsocket;
}
