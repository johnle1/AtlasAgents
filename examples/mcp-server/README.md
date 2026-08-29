# Atlas MCP server template

A copy-me starting point for building your own [MCP](https://modelcontextprotocol.io) server for [AtlasAgents](../../README.md). The MCP spec tells you how to write a server; this template shows the parts specific to how Atlas *uses* one.

## Run it

```bash
npm install
npm run build
npm test
```

## Connect it to Atlas

```
/mcp add demo --command node --args <path-to-this-folder>/dist/stdio.js
/mcp tools demo
```

You should see two tools: `mcp__demo__demo_search` (marked read-only) and `mcp__demo__demo_create`. Ask the agent to search, then ask it to create something — notice the second one prompts for approval and the first doesn't. That difference is the entire point of this template.

## What's here

| File | Purpose |
| --- | --- |
| `src/tools.ts` | The three demo tools and `createServer()`. **This is the file you edit.** |
| `src/stdio.ts` | Transport wiring only — connects `createServer()` to stdin/stdout. You shouldn't need to touch this. |
| `test/tools.test.ts` | Protocol-level tests using the SDK's in-memory transport — no subprocess needed to run them. |

## The three tools, and why they're shaped this way

None of them do anything real — they all read and write one hardcoded in-memory array that resets on restart. They exist to demonstrate one thing each:

- **`demo_search`** — read-only archetype (think GitHub's `search_issues`, Jira's search). Marked `readOnlyHint: true` in its `annotations`. In Atlas, that means it runs **with no approval prompt** and stays available in plan mode.
- **`demo_create`** — mutating archetype (think `create_issue`, `send_message`). Marked `readOnlyHint: false`. Atlas gates it behind a run/skip/revise approval prompt and withholds it entirely in plan mode.
- **`demo_fail`** — always fails, to show the *correct* shape for a tool failure: return `{ isError: true, content: [...] }` from the handler. If you `throw` instead, it becomes a JSON-RPC protocol error the model never sees and can't recover from — that's a much worse failure mode than a visible tool error.

Delete all three bodies and keep the surrounding shape (the `registerTool` calls, the annotations, the zod schemas, the error handling) when you start your own.

## The four things Atlas needs that the MCP spec won't tell you

1. **`annotations.readOnlyHint` decides your approval prompt and your plan-mode availability.** Set it accurately. If you leave it unset, Atlas treats your tool as *not* read-only — the safer default, but it means every call prompts and none of your tools survive plan mode. `readOnlyHint` is a hint, not a guarantee: the SDK's own docs note clients shouldn't blindly trust it from untrusted servers. Atlas trusts it for servers *you* configured, which is the reasonable call — but if you ever need to override what a tool claims about itself, `/mcp add <name> --readonly` (or editing `mcpServers` config directly) forces every tool from that server to be treated as read-only regardless of what it declares.
2. **Your tool `description` is what the model reads to decide whether your tool applies to the task at hand.** Atlas renders it directly into the model's `[AVAILABLE TOOLS]` prompt. A terse name with no description leaves the model guessing — write descriptions the way you'd explain the tool to someone who's never seen your service.
3. **Credentials arrive as environment variables.** Whatever you store in Atlas's `/mcp add` credential prompt (or `mcpSecrets` in config) gets merged into this process's environment when Atlas spawns it — see the top of `stdio.ts`. Read it with `process.env.YOUR_VAR_NAME`.
4. **stdout is the protocol, not your console.** `StdioServerTransport` speaks JSON-RPC over stdin/stdout. Any stray `console.log` — yours or a dependency's — corrupts that stream, and the failure mode is a garbled or hanging connection with no useful error message. Log to `process.stderr` instead, always.

## If you're building an HTTP server instead

This template is stdio-only. If your server needs to run as a shared, hosted service instead of a process Atlas spawns, use `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js` in place of `StdioServerTransport` — it accepts raw `node:http` requests directly via `transport.handleRequest(req, res)`, no framework required.

The credential path is different for HTTP: Atlas sends whatever you stored under the `token` key as an `Authorization: Bearer <token>` header on every request, so check `req.headers.authorization` before delegating to the transport, rather than reading `process.env`.
