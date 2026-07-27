# LoopyCode

LoopyCode is a self-hosted, client/server AI coding agent. You run **`loopy-server`** on a machine with access to an LLM (local via [Ollama](https://ollama.com), or any OpenAI-compatible endpoint such as vLLM), and connect to it from **`loopy`**, a terminal client, over an encrypted RSocket/TCP connection. This monorepo contains both, plus the types/utilities they share.

| Workspace | Path | What it is |
|-----------|------|------------|
| `loopycode` | `packages/client` | The `loopy` terminal client (Ink/React TUI). Connects to a server, runs the REPL. |
| `loopycode-server` | `packages/server` | The `loopy-server` agent runtime: task orchestration, memory, skills, provider routing, TLS/auth. |
| `@loopycode/shared` | `packages/shared` | Shared diff/type utilities used by both. |

None of these packages are published to npm yet, so everything below is built and run from source.

## How it fits together

- **Orchestration** (`packages/server/src/orchestration`): a lead agent breaks a task into a plan, then a pool of subagents execute subtasks (read/edit files, run commands), escalating back to the lead agent when stuck.
- **Memory** (`packages/server/src/memory`): session continuity, learned preferences, and reusable patterns are extracted from past tasks and consolidated periodically, so the agent improves within a given `loopy-server` data directory over time.
- **Skills** (`user-data/skills/` server-side, `~/.agent-cli/skills/` client-side): markdown instruction files the client syncs to the server; the server picks the most relevant one per task.
- **Providers**: any role (agent/subagent) can be pointed at `ollama` or at a named OpenAI-compatible backend. `loopy-detect-hardware` inspects the host (NVIDIA GPU / AWS Trainium / GCP TPU / CPU) and suggests a `vllm serve` provider configuration.

The directory you launch `loopy-server` from is both its **data root** (`user-data/`, `tls/` get created there) and its **workspace root** (the files it reads/edits). In practice: run it from inside the project you want the agent to work on, and add `user-data/` and `tls/` to that project's `.gitignore`.

## Build

Run **`npm install` from the repository root** (not from `packages/client`, `packages/server`, or `packages/shared`). The root `package.json` uses npm workspaces (`packages/*`), which includes `packages/shared` as `@loopycode/shared`. Installing inside a single package folder will not link the local shared package correctly.

Requires Node.js 24 (matches CI in [.github/workflows/test.yml](.github/workflows/test.yml)).

```bash
cd /path/to/LoopyCode
npm install
npm run build -w @loopycode/shared
npm run build -w loopycode-server
npm run build -w loopycode
```

## Run the server

```bash
mkdir -p ~/my-project && cd ~/my-project   # the folder loopy-server will operate on
node /path/to/LoopyCode/packages/server/dist/server/index.js
# or, once linked globally: loopy-server
```

On first run it will interactively prompt for:

1. **A password** — required, used by clients to authenticate. Can't be empty.
2. **A TCP port** — defaults to `7000` if left blank.

It then generates a self-signed TLS certificate under `./tls/` (2048-bit, ~2-year validity) and writes its config to `./user-data/config.json`, both relative to the directory you launched it from. Reuse the same directory on later starts so the password, cert, and learned memory persist.

If a role is configured to use the `ollama` provider, the server checks `http://localhost:11434` and auto-runs `ollama serve` if it isn't already up — but you must install Ollama yourself first, and `ollama pull` at least one model before the agent can use it.

To detect your hardware and get a suggested provider config for a local vLLM server instead of Ollama:

```bash
loopy-detect-hardware        # print a suggested config + vllm serve command
loopy-detect-hardware --write  # also add it to config.json
```

Rotate the TLS certificate (e.g. after it expires) with:

```bash
loopy-server --regen-cert
```

## Run the client

```bash
node /path/to/LoopyCode/packages/client/dist/index.js
# or, once linked globally: loopy
```

The first run walks you through a setup wizard (server address → port → password), then saves the result to `~/.agent-cli/config.json`. The client pins the server's TLS certificate fingerprint on first connect (trust-on-first-use); if the server's cert changes later (e.g. after `--regen-cert`), reconnect with `--trust-fingerprint` to re-pin it.

### CLI flags

```
Usage: loopy [options] [start]

Options:
  -H, --host <host>       Server host (e.g. 0.0.0.0, localhost)
  -s, --server <host>     Same as --host
  -p, --port <port>       Server port (default from config, usually 7000)
  -h, --help              Show this help

Config repair (saves to config.json and exits — no server connection needed,
asks for your config passphrase first):
  -a, --address <host>    Save a new server address
      --port <port>       Save a new port (alongside --reset/--password/--address)
      --password          Prompt for and save a new server password
      --reset             Clear the saved password, address, port, and pinned
                          TLS certificate fingerprint
      --trust-fingerprint Clear the pinned TLS certificate fingerprint for the
                          configured server (re-trust on next connect)

Examples:
  loopy
  loopy start --host 0.0.0.0 --port 7000
  loopy --address 10.0.0.7 --port 8001 --password
  loopy --reset
```

`--host`/`--server`/`--port` alone only override the connection for that one run. `--reset`, `--password`, `--address`, and `--trust-fingerprint` switch into config-repair mode instead: they persist to `config.json` and exit without contacting the server, which is the only way back in if the server's address/port/password changed out from under you.

### In-app commands

Once connected, the REPL takes slash-commands:

| Command | Purpose |
|---|---|
| `/set password\|server\|port\|agent\|subagent` | Change connection/role settings for the current session |
| `/agent` | Inspect/control the lead agent |
| `/config` | Show current configuration |
| `/skills list\|add\|sync` | Manage skill files |
| `/memory show\|forget\|clear` | Inspect or clear learned memory |
| `/models list\|find\|pull\|delete\|show\|running` | Manage models on the configured provider |
| `/providers list\|add\|remove` | Manage LLM provider backends |
| `/new` | Start a new task |
| `/explore` | Explore-only mode (read, no edits) |
| `/tokensave init\|status` | Manage the optional TokenSave code-index integration |
| `/workspace` | Workspace info/controls |
| `/cwd` | Show/change the working directory |
| `/think` | Toggle/adjust reasoning verbosity |
| `/spinner` | Toggle the loading spinner |
| `/theme` | Pick a color theme |
| `/exit` | Quit |

### Optional: TokenSave

`/tokensave` integrates with TokenSave, a separate Rust-based code-intelligence indexer that speeds up workspace search/navigation via MCP. Install it with `cargo install tokensave`, then run `/tokensave init` inside the client.

## Testing

Tests live in [`_Test_/`](_Test_) (unit, integration, and system/E2E), separate from the workspace packages. CI ([.github/workflows/test.yml](.github/workflows/test.yml)) runs `npm run build` at the root, then `npm ci` inside `_Test_` before each suite:

```bash
cd _Test_
npm ci
npm run test:unit
npm run test:integration
npm run test:e2e
```

## Publishing

`packages/client` and `packages/server` depend on `@loopycode/shared` via a semver range (`^0.1.0`). Inside this workspace, npm links the local `packages/shared` build automatically — no registry publish is required for local development. Outside the workspace, that same version range resolves `@loopycode/shared` from the npm registry, which is what makes each package independently installable.

`@loopycode/shared` must be published before `loopycode` or `loopycode-server`, since both depend on it by version range:

```bash
npm publish -w @loopycode/shared
npm publish -w loopycode-server
npm publish -w loopycode
```

Once published, each package installs independently:

| Package | Install |
|---------|---------|
| `@loopycode/shared` | `npm install @loopycode/shared` |
| `loopycode-server` | `npm install -g loopycode-server` |
| `loopycode` | `npm install -g loopycode` |
