# Atlas MCP server template

A copy-me starting point for building your own [MCP](https://modelcontextprotocol.io) server for [AtlasAgents](../../README.md). The MCP spec tells you how to write a server; this template shows the parts specific to how Atlas *uses* one.

## Run it

```bash
npm install
npm run build
npm test
```

## Connect it to Atlas

Over stdio (the common case — Atlas spawns the process itself):

```
/mcp add demo --command node --args <path-to-this-folder>/dist/stdio.js
/mcp tools demo
```

Or over HTTP, if you'd rather run it as a standalone service (see "If you're building an HTTP server instead" below):

```
node dist/http.js   # prints the URL it bound to stderr
/mcp add demo --url http://127.0.0.1:<port>/mcp --token <anything>
/mcp tools demo
```

You should see four tools: `mcp__demo__demo_search` (marked read-only), `mcp__demo__demo_create`, `mcp__demo__demo_fail`, and `mcp__demo__demo_whoami`. Ask the agent to search, then ask it to create something — notice the second one prompts for approval and the first doesn't. That difference is the entire point of this template.

## What's here

| File | Purpose |
| --- | --- |
| `src/tools.ts` | The four demo tools and `createServer()`. **This is the file you edit.** |
| `src/stdio.ts` | stdio transport wiring — connects `createServer()` to stdin/stdout. You shouldn't need to touch this. |
| `src/http.ts` | HTTP transport wiring — the same `createServer()` over streamable HTTP (default) or legacy SSE (`--sse`). Only relevant if you're building a hosted server instead of a spawned process; see below. |
| `test/tools.test.ts` | Protocol-level tests using the SDK's in-memory transport — no subprocess needed to run them. |

## The four tools, and why they're shaped this way

None of them do anything real — they all read and write one hardcoded in-memory array that resets on restart (`demo_search`/`demo_create`/`demo_fail`), or report on the current request (`demo_whoami`). They exist to demonstrate one thing each:

- **`demo_search`** — read-only archetype (think GitHub's `search_issues`, Jira's search). Marked `readOnlyHint: true` in its `annotations`. In Atlas, that means it runs **with no approval prompt** and stays available in plan mode.
- **`demo_create`** — mutating archetype (think `create_issue`, `send_message`). Marked `readOnlyHint: false`. Atlas gates it behind a run/skip/revise approval prompt and withholds it entirely in plan mode.
- **`demo_fail`** — always fails, to show the *correct* shape for a tool failure: return `{ isError: true, content: [...] }` from the handler. If you `throw` instead, it becomes a JSON-RPC protocol error the model never sees and can't recover from — that's a much worse failure mode than a visible tool error.
- **`demo_whoami`** — only interesting when run over HTTP/SSE (`http.ts`), a no-op over stdio. Reports which non-boilerplate headers arrived with the call, without ever echoing their values — proof that a `/mcp add --token`/`--header` credential really reaches your server as a request header, not just config Atlas keeps to itself.

Delete all four bodies and keep the surrounding shape (the `registerTool` calls, the annotations, the zod schemas, the error handling) when you start your own.

## The four things Atlas needs that the MCP spec won't tell you

1. **`annotations.readOnlyHint` decides your approval prompt and your plan-mode availability.** Set it accurately. If you leave it unset, Atlas treats your tool as *not* read-only — the safer default, but it means every call prompts and none of your tools survive plan mode. `readOnlyHint` is a hint, not a guarantee: the SDK's own docs note clients shouldn't blindly trust it from untrusted servers. Atlas trusts it for servers *you* configured, which is the reasonable call — but if you ever need to override what a tool claims about itself, `/mcp add <name> --readonly` (or editing `mcpServers` config directly) forces every tool from that server to be treated as read-only regardless of what it declares.
2. **Your tool `description` is what the model reads to decide whether your tool applies to the task at hand.** Atlas renders it directly into the model's `[AVAILABLE TOOLS]` prompt. A terse name with no description leaves the model guessing — write descriptions the way you'd explain the tool to someone who's never seen your service.
3. **Credentials arrive as environment variables over stdio, and as request headers over HTTP.** Whatever you store in Atlas's `/mcp add` credential prompt (or `mcpSecrets` in config) gets merged into the child process's environment when Atlas spawns it over stdio (see the top of `stdio.ts`) — read it with `process.env.YOUR_VAR_NAME`. Over HTTP, a `--token` becomes an `Authorization: Bearer <token>` header and each `--header Name=value` becomes that literal header on every request instead — see `demo_whoami` in `tools.ts` for how to read them.
4. **stdout is the protocol, not your console — over stdio.** `StdioServerTransport` speaks JSON-RPC over stdin/stdout. Any stray `console.log` — yours or a dependency's — corrupts that stream, and the failure mode is a garbled or hanging connection with no useful error message. Log to `process.stderr` instead, always. (This doesn't apply to `http.ts` — stdout is free there — but it logs to stderr too, for consistency.)

## If you're building an HTTP server instead

`src/http.ts` covers this rather than leaving it as an exercise: `node dist/http.js` runs the same `createServer()` over `StreamableHTTPServerTransport` (the modern default, session-scoped via `Mcp-Session-Id`, following the MCP SDK's own reference pattern for a stateful server) instead of `StdioServerTransport` — plain `node:http`, no framework required. It binds an OS-assigned port and prints the URL it bound to stderr.

Some older MCP servers only speak the deprecated SSE transport (`GET` a stream, `POST` replies to a separately-discovered endpoint) instead of streamable HTTP. `node dist/http.js --sse` runs that path instead, at the same `/mcp` URL, so Atlas's `/mcp add --url` never needs to know which one it's talking to — it tries streamable HTTP first and falls back to SSE automatically (see `mcpRegistry.ts`'s `getMcpClient`). A real server should only ever run one mode; `http.ts` supports both purely so this one file can demonstrate — and be tested against — either of Atlas's HTTP code paths.

The credential path is different for HTTP: see point 3 above, and `demo_whoami`'s implementation in `tools.ts` for reading whatever header arrived.
