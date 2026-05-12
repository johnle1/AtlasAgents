import * as http from "node:http";
import * as https from "node:https";
import type { Config } from "./config.js";

/**
 * <Summary>
 * What it does:
 *   Represents one topic in the user's server-side preference store.
 *
 * Used by:
 *   - Connection.getMemory — returned in the array of memory entries.
 *   - renderer.printMemory — displays each entry to the user.
 *
 * Produced by:
 *   - Server /api/memory endpoint — fetched via GET request.
 * </Summary>
 */
export interface MemoryEntry {
  /** Topic name e.g. "coding-style" or "project-structure" */
  topic: string;

  /** Array of preference rules the server learned for this topic */
  rules: string[];
}

/**
 * <Summary>
 * What it does:
 *   Represents one skill file to be synced to the server.
 *
 * Used by:
 *   - Connection.syncSkills — accepts an array of these in the request body.
 *   - skills.readAllSkills — produces an array of these from local .md files.
 *
 * Produced by:
 *   - skills.readAllSkills — reads ~/.agent-cli/skills/*.md into this shape.
 * </Summary>
 */
export interface SkillPayload {
  /** Skill file basename without extension e.g. "coding" */
  name: string;

  /** Full markdown content of the skill file */
  content: string;
}

/**
 * Callback invoked for each token received during streaming task execution.
 */
type TokenCallback = (token: string) => void;

/**
 * <Summary>
 * What it does:
 *   Sends a simple HTTP request (GET, POST, DELETE) to the server and
 *   returns the status code and response body as a string.
 *
 * How it does it (step by step):
 *   1. Parses the URL to determine protocol (http vs https) and path.
 *   2. Constructs http.RequestOptions with method, hostname, port, and headers.
 *   3. Sends the request with JSON body if provided.
 *   4. Collects response chunks into a buffer.
 *   5. Resolves with { status, body } when the response completes.
 *   6. Rejects on network errors.
 *
 * Parameters:
 *   @param {string} url — Full URL including protocol and path.
 *   @param {string} method — HTTP method: "GET", "POST", "DELETE", etc.
 *   @param {unknown} body — Optional JSON payload to send in request body.
 *
 * Returns:
 *   @returns {Promise<{ status: number; body: string }>} — Status code and response text.
 *
 * Dependencies:
 *   - http.request / https.request — Node.js built-in HTTP clients.
 *
 * Dependants:
 *   - Connection.listModels — fetches /api/models.
 *   - Connection.syncSkills — posts /api/skills/sync.
 *   - Connection.getMemory — fetches /api/memory.
 *   - Connection.forgetMemory — deletes /api/memory/:topic.
 *   - Connection.clearMemory — deletes /api/memory.
 * </Summary>
 */
const request = (
  url: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: string }> => {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const driver = parsed.protocol === "https:" ? https : http;
    const options: http.RequestOptions = {
      method,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: { "Content-Type": "application/json" },
    };

    const req = driver.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });

    req.on("error", reject);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
};

/**
 * <Summary>
 * What it does:
 *   Manages all HTTP communication with the LoopyCode server including
 *   fetching models, streaming task execution, syncing skills, and
 *   managing user memory.
 *
 * How it fits in the system:
 *   Acts as the single HTTP client layer between the CLI and the server.
 *   All server communication goes through this class so network logic is
 *   centralized in one place.
 *
 * Dependencies:
 *   - request() — internal helper for simple HTTP calls.
 *   - http/https — Node.js built-in for SSE streaming in sendTask.
 *
 * Dependants:
 *   - index.ts main() — creates a Connection instance on startup.
 *   - CommandHandler — calls listModels, syncSkills, getMemory, forgetMemory, clearMemory.
 *   - index.ts rl.on('line') — calls sendTask for plain text input.
 * </Summary>
 */
export class Connection {
  /**
   * @param {Config} config — Configuration object with server URL and model settings.
   */
  constructor(private config: Config) {}

  /**
   * <Summary>
   * What it does:
   *   Updates the internal config reference so subsequent requests use
   *   the new server URL and model settings.
   *
   * How it does it (step by step):
   *   1. Assigns the new config to this.config.
   *
   * Parameters:
   *   @param {Config} config — The updated configuration.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - CommandHandler.handleSet — reloads config after user picks a new model.
   * </Summary>
   */
  reload = (config: Config): void => {
    this.config = config;
  };

  /**
   * <Summary>
   * What it does:
   *   Builds a full URL by prepending the server base URL to a path.
   *
   * How it does it (step by step):
   *   1. Template-concatenates this.config.server with the path argument.
   *
   * Parameters:
   *   @param {string} path — API path e.g. "/api/models".
   *
   * Returns:
   *   @returns {string} — Full URL e.g. "http://localhost:3000/api/models".
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - All Connection methods — use this to construct request URLs.
   * </Summary>
   */
  private url = (path: string): string => {
    return `${this.config.server}${path}`;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Fetches the list of available Ollama models from the server so
   *   users can pick one for advisor or agent roles.
   *
   * How it does it (step by step):
   *   1. Sends GET request to /api/models.
   *   2. Checks response status — throws if not 200.
   *   3. Parses JSON body and extracts the models array.
   *   4. Returns the array of model name strings.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<string[]>} — Array of model names e.g. ["gemma3:4b", "gemma3:27b"].
   *
   * @throws {Error} — When server returns non-200 status.
   *
   * Dependencies:
   *   - request() — internal HTTP helper.
   *
   * Dependants:
   *   - CommandHandler.handleSet — calls this to populate the model picker.
   * </Summary>
   */
  listModels = async (): Promise<string[]> => {
    const res = await request(this.url("/api/models"), "GET");
    if (res.status !== 200) {
      throw new Error(`Failed to fetch models: ${res.status} ${res.body}`);
    }
    const data = JSON.parse(res.body) as { models: string[] };
    return data.models;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Streams a task to the server and invokes a callback for each token
   *   received in the SSE response stream.
   *
   * How it does it (step by step):
   *   1. Constructs POST request to /api/task with task text and config.
   *   2. Sets Accept: text/event-stream to enable SSE streaming.
   *   3. Opens HTTP request and listens for data events.
   *   4. Parses each SSE line starting with "data: ".
   *   5. Extracts token field from JSON and calls onToken callback.
   *   6. Resolves when the stream ends.
   *
   * Parameters:
   *   @param {string} task — User's task description to execute.
   *   @param {TokenCallback} onToken — Function called with each token string.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves when streaming completes.
   *
   * @throws {Error} — When server returns non-200 status or network fails.
   *
   * Dependencies:
   *   - http/https request — Node.js built-in for SSE streaming.
   *
   * Dependants:
   *   - index.ts rl.on('line') — calls this for plain text task input.
   * </Summary>
   */
  sendTask = (task: string, onToken: TokenCallback): Promise<void> => {
    return new Promise((resolve, reject) => {
      const parsed = new URL(this.url("/api/task"));
      const driver = parsed.protocol === "https:" ? https : http;

      const payload = JSON.stringify({
        task,
        advisorModel: this.config.advisorModel,
        agentModel: this.config.agentModel,
        advisorTemp: this.config.advisorTemp,
        agentTemp: this.config.agentTemp,
      });

      const options: http.RequestOptions = {
        method: "POST",
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      const req = driver.request(options, (res) => {
        if (res.statusCode !== 200) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            reject(
              new Error(
                `Server error ${res.statusCode}: ${Buffer.concat(chunks).toString()}`,
              ),
            );
          });
          return;
        }

        let buffer = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const payload = line.slice(6);
              if (payload === "[DONE]") continue;
              try {
                const parsed = JSON.parse(payload) as { token?: string };
                if (parsed.token) onToken(parsed.token);
              } catch {
                onToken(payload);
              }
            }
          }
        });
        res.on("end", resolve);
        res.on("error", reject);
      });

      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Uploads all local skill files to the server so they're available
   *   to the advisor and agent during task execution.
   *
   * How it does it (step by step):
   *   1. Sends POST request to /api/skills/sync with skills array in body.
   *   2. Checks response status — throws if not 200.
   *
   * Parameters:
   *   @param {SkillPayload[]} skills — Array of skill objects with name and content.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * @throws {Error} — When server returns non-200 status.
   *
   * Dependencies:
   *   - request() — internal HTTP helper.
   *
   * Dependants:
   *   - CommandHandler.handleSkills (sync subcommand) — calls this after reading local files.
   * </Summary>
   */
  syncSkills = async (skills: SkillPayload[]): Promise<void> => {
    const res = await request(this.url("/api/skills/sync"), "POST", { skills });
    if (res.status !== 200) {
      throw new Error(`Failed to sync skills: ${res.status} ${res.body}`);
    }
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Fetches all stored memory entries from the server's preference store
   *   so users can review what the system has learned about their preferences.
   *
   * How it does it (step by step):
   *   1. Sends GET request to /api/memory.
   *   2. Checks response status — throws if not 200.
   *   3. Parses JSON body and extracts the entries array.
   *   4. Returns the array of MemoryEntry objects.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   @returns {Promise<MemoryEntry[]>} — Array of topics with their rules.
   *
   * @throws {Error} — When server returns non-200 status.
   *
   * Dependencies:
   *   - request() — internal HTTP helper.
   *
   * Dependants:
   *   - CommandHandler.handleMemory (show subcommand) — calls this to display memory.
   * </Summary>
   */
  getMemory = async (): Promise<MemoryEntry[]> => {
    const res = await request(this.url("/api/memory"), "GET");
    if (res.status !== 200) {
      throw new Error(`Failed to fetch memory: ${res.status} ${res.body}`);
    }
    const data = JSON.parse(res.body) as { entries: MemoryEntry[] };
    return data.entries;
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Deletes all rules for a specific topic from the server's memory store.
   *
   * How it does it (step by step):
   *   1. URL-encodes the topic name.
   *   2. Sends DELETE request to /api/memory/:topic.
   *   3. Checks response status — throws if not 200.
   *
   * Parameters:
   *   @param {string} topic — Topic name to forget e.g. "coding-style".
   *
   * Returns:
   *   void — called for side effects only.
   *
   * @throws {Error} — When server returns non-200 status.
   *
   * Dependencies:
   *   - request() — internal HTTP helper.
   *
   * Dependants:
   *   - CommandHandler.handleMemory (forget subcommand) — calls this after user confirms.
   * </Summary>
   */
  forgetMemory = async (topic: string): Promise<void> => {
    const res = await request(
      this.url(`/api/memory/${encodeURIComponent(topic)}`),
      "DELETE",
    );
    if (res.status !== 200) {
      throw new Error(`Failed to forget topic: ${res.status} ${res.body}`);
    }
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Wipes all memory entries from the server's preference store for this user.
   *
   * How it does it (step by step):
   *   1. Sends DELETE request to /api/memory.
   *   2. Checks response status — throws if not 200.
   *
   * Parameters:
   *   None.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * @throws {Error} — When server returns non-200 status.
   *
   * Dependencies:
   *   - request() — internal HTTP helper.
   *
   * Dependants:
   *   - CommandHandler.handleMemory (clear subcommand) — calls this after user confirms.
   * </Summary>
   */
  clearMemory = async (): Promise<void> => {
    const res = await request(this.url("/api/memory"), "DELETE");
    if (res.status !== 200) {
      throw new Error(`Failed to clear memory: ${res.status} ${res.body}`);
    }
  };
}
