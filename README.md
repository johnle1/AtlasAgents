# AtlasAgents

AtlasAgents is a self-hosted, client/server AI coding agent. You run **`atlas-server`** on a machine with access to an LLM (local via [Ollama](https://ollama.com), or any OpenAI-compatible endpoint such as vLLM), and connect to it from **`atlas`**, a terminal client, over an encrypted RSocket/TCP connection.

## Features

- **Self-hosted** — your code and prompts never leave a machine you control; the LLM can be fully local (Ollama) or point at any OpenAI-compatible backend (vLLM, etc.).
- **Encrypted client/server** — TLS with trust-on-first-use certificate pinning, plus password authentication.
- **Task orchestration** — a lead agent plans a task, then a pool of subagents execute subtasks (read/edit files, run commands), escalating back to the lead agent when stuck.
- **Persistent memory** — session continuity, learned preferences, and reusable patterns are extracted from past tasks and consolidated over time.
- **Skills** — markdown instruction files that the client syncs to the server; the server picks the most relevant one per task.
- **Hardware-aware provider setup** — `atlas-detect-hardware` inspects the host (NVIDIA GPU / AWS Trainium / GCP TPU / CPU) and suggests a `vllm serve` configuration.
- **Optional code-index integration** — [TokenSave](#optional-tokensave) speeds up workspace search/navigation via MCP.

`atlasagents` and `atlasagents-server` are published to npm — install them directly, or build from this monorepo if you're contributing.

## Requirements

- Node.js 22
- An LLM backend: [Ollama](https://ollama.com) installed locally
- Optional: Rust/`cargo`, if you want the [TokenSave](#optional-tokensave) integration

## Quick Start

**Option A: install from npm** (recommended for most users)

```bash
npm install -g atlasagents-server
npm install -g atlasagents

# 1. Start the server
atlas-server start

# 2. Start the client, from the directory you want the agent to work on
mkdir -p ~/my-project && cd ~/my-project
atlas start
```

**Option B: build from source** (for contributing to AtlasAgents itself)

```bash
# 1. Clone and build
git clone <this-repo> AtlasAgents
cd AtlasAgents
npm install                              # run from the repo root — see note below
npm run build -w @atlasagents/shared
npm run build -w atlasagents-server
npm run build -w atlasagents

# 2. Start the server
node /path/to/AtlasAgents/packages/server/dist/server/index.js

# 3. Start the client, from the directory you want the agent to work on
mkdir -p ~/my-project && cd ~/my-project
node /path/to/AtlasAgents/packages/client/dist/index.js
```

> **Note on `npm install`:** run it from the **repository root**, not from `packages/client`, `packages/server`, or `packages/shared`. The root `package.json` uses npm workspaces (`packages/*`), which includes `packages/shared` as `@atlasagents/shared`. Installing inside a single package folder will not link the local shared package correctly.

The first time you run `atlas-server`, it interactively prompts for:

1. **A passphrase** — encrypts the password, port, and any provider API keys at rest. Entered once per launch from then on.
2. **A password** — required, used by clients to authenticate. Can't be empty.
3. **A TCP port** — defaults to `7000` if left blank.

The password and port are then saved (encrypted) to `./user-data/startup.json`, so on later starts you only re-enter the passphrase — the server reads the rest back automatically. To change the saved password or port later without starting the server, see `atlas-server --password`/`--port`/`--reset` below.

It also generates a self-signed TLS certificate under `./tls/` and writes model/provider config to `./user-data/config.json`, both relative to the directory you launched it from. Reuse the same directory on later starts so the password, cert, and learned memory persist. If a role is configured to use `ollama`, the server checks `http://localhost:11434` and auto-runs `ollama serve` if it isn't already up — but you must install Ollama and `ollama pull` at least one model yourself first.

The first time you run `atlas`, it walks you through a setup wizard (server address → port → password) and saves the result to `~/.atlasagents/config.json`.

**First prompt:** once connected, just type a task at the REPL prompt and press enter — e.g. `explain what this repo does`. Use `/exit` to quit.

## Security

- All client/server traffic runs over an encrypted RSocket/TCP connection secured with TLS.
- The server generates a self-signed certificate (2048-bit, ~2-year validity) on first run.
- The client pins the server's certificate fingerprint on first connect (trust-on-first-use). If the server's cert changes later (e.g. after `--regen-cert`), reconnect with `atlas --trust-fingerprint` to re-pin it.
- Clients authenticate with the password set on the server's first run.
- The directory you launch `atlas-server` from is both its **data root** (`user-data/`, `tls/` are created there) and its **workspace root** (the files it reads/edits). Add `user-data/` and `tls/` to that project's `.gitignore`.

### Config encryption at rest

Every config file encrypts its sensitive fields (AES-256-GCM, scrypt-derived key) rather than storing them in plaintext — each side behind its own passphrase, prompted once per launch:

| Config file                              | Encrypted fields                                                                | Passphrase prompted            |
| ----------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------ |
| Client `~/.atlasagents/config.json`         | `password` (server auth password) and `server` (host)                           | Once per `atlas` launch    |
| Server `./user-data/startup.json`         | `password` (client-auth password) and `port` (TCP listen port)                  | Once per `atlas-server` launch |
| Server `./user-data/config.json`          | `providers` map (`baseUrl`/`apiKey` for third-party OpenAI-compatible backends) | Once per `atlas-server` launch |

The server's `startup.json` and `config.json` share one passphrase and one derived key — you're only prompted once at server startup either way. Everything else in each file (model names, timeouts, workspace path, pinned TLS fingerprints, etc.) stays plaintext — only the fields above are sensitive enough to encrypt. The client and server passphrases are independent of each other; neither passphrase is itself written to disk. Forgetting a passphrase isn't a dead end: after 3 wrong attempts on `atlas`/`atlas-server start` you're offered a reset (backs up the existing encrypted file(s), then discards and re-prompts for a fresh passphrase).

`atlas-server --password`/`--port`/`--reset` (config-repair mode, like the client's) also require the correct passphrase — but unlike `start`, a wrong entry there just fails with an error rather than offering the reset menu, so it can't be used to bypass the auth password without knowing the passphrase.

## Providers (Ollama, vLLM)

Any role (agent/subagent) can be pointed at `ollama` or at a named OpenAI-compatible backend.

- **Ollama**: install it yourself. The server auto-starts `ollama serve` if needed.
- **vLLM (or other OpenAI-compatible endpoints)**: run `atlas-detect-hardware` to get a suggested provider config for your hardware:

  ```bash
  atlas-detect-hardware          # print a suggested config + vllm serve command
  atlas-detect-hardware --write  # also add it to config.json
  ```

- Manage providers from the client with `/providers list|add|remove`, and models with `/models list|find|pull|delete|show|running|storage`.

### Model storage: why `/models delete` doesn't always free space

Ollama content-addresses model layers by digest, so two tags that share layers (e.g. `gemma3:12b`
and `gemma3:latest` built from the same weights) only occupy that space once — deleting one tag
frees nothing if the other tag still references every blob it used. Interrupted pulls also leave
behind partial blob files that no tag references at all, which `/models list` can't show and
`/models delete` can never reach. Run `/models storage` for a real accounting: per-model unique vs.
shared bytes, and any orphaned files with the exact `rm -rf` command to remove them yourself — the
command only reports, it never deletes anything on its own.

### Using one model for both agent and subagent

The agent (planning) and subagent (execution) roles are independent settings — nothing stops you
from picking the same model for both, e.g. `/set agent` → `gemma3:12b` and `/set subagent` →
`gemma3:12b`. This is fully supported and is actually the cheapest setup on limited VRAM: Ollama
keys its loaded model by tag, so a shared tag loads into memory **once**, not twice. The
`/set agent|subagent` picker marks your current selections (`← current agent`, `← current
subagent`, or `← current agent + subagent` when they match) so you can see at a glance which
model each role is already using.

## Common commands

### CLI flags (`atlas`)

```
Usage: atlas [options] [start|run]

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
  atlas
  atlas start --host 0.0.0.0 --port 7000
  atlas run --host 0.0.0.0 --port 7000
  atlas --address 10.0.0.7 --port 8001 --password
  atlas --reset
```

`--host`/`--server`/`--port` alone only override the connection for that one run. `--reset`, `--password`, `--address`, and `--trust-fingerprint` switch into config-repair mode instead: they persist to `config.json` and exit without contacting the server.

### CLI flags (`atlas-server`)

```
Usage:
  atlas-server [start|run]  Interactive startup, then listen for RSocket clients
  atlas-server --regen-cert Rotate the TLS certificate (asks for confirmation)

Config repair (saves to user-data/startup.json and exits — no listening,
asks for your server config passphrase first):
  --port [port]  Save a new TCP port (omit the value to be prompted)
  --password     Prompt for and save a new server auth password
  --reset        Prompt for a new password and port, replacing the old ones;
                 leaves the passphrase and provider keys alone

Examples:
  atlas-server
  atlas-server start
  atlas-server run
  atlas-server --port 8001
  atlas-server --password
  atlas-server --reset --port 8001
  atlas-server --regen-cert
```

Rotate the server's TLS certificate (e.g. after it expires):

```bash
atlas-server --regen-cert
```

### In-app commands (REPL)

| Command                                           | Purpose                                                 |
| ------------------------------------------------- | ------------------------------------------------------- |
| `/set password\|server\|port\|agent\|subagent`    | Change connection/role settings for the current session |
| `/agent`                                          | Inspect/control the lead agent                          |
| `/config`                                         | Show current configuration                              |
| `/skills list\|add\|sync`                         | Manage skill files                                      |
| `/memory show\|forget\|clear`                     | Inspect or clear learned memory                         |
| `/models list\|find\|pull\|delete\|show\|running\|storage` | Manage models; `storage` reports real on-disk usage |
| `/providers list\|add\|remove`                    | Manage LLM provider backends                            |
| `/new`                                            | Start a new task                                        |
| `/explore`                                        | Explore-only mode (read, no edits)                      |
| `/tokensave init\|status`                         | Manage the optional TokenSave code-index integration    |
| `/workspace`                                      | Workspace info/controls                                 |
| `/cwd`                                            | Show/change the working directory                       |
| `/think`                                          | Toggle/adjust reasoning verbosity                       |
| `/spinner`                                        | Toggle the loading spinner                              |
| `/theme`                                          | Pick a color theme                                      |
| `/help`                                           | Show all slash commands                                 |
| `/clear`                                          | Clear the screen (Ctrl+L)                               |
| `/notify on\|off`                                 | Toggle desktop notifications (opt-in, default off)      |
| `/exit`                                           | Quit (Ctrl+C on empty input)                            |
| `!<command>`                                      | Run a local shell command (not sent to the agent)       |

### Keyboard shortcuts

| Keys     | Action                                          |
| -------- | ----------------------------------------------- |
| `Esc`    | Cancel running task / clear input               |
| `Ctrl+C` | Cancel task / clear input / quit                |
| `Ctrl+L` | Clear the screen                                |
| `Ctrl+O` | Expand truncated directory listing              |
| `Tab`    | Accept autocomplete suggestion                  |
| `↑` / `↓` | Previous / next history or suggestion          |
| `Enter`  | Submit input; while a task runs, queue the line |
| `Shift+Enter` / `Alt+Enter` / `Ctrl+J` | Insert a newline in the prompt     |
| `Alt+M`  | Toggle raw markdown source for assistant text   |
| `Shift+Tab` | Cycle approval mode (default / accept-edits / plan) |
| `?`      | Toggle the shortcuts cheat-sheet (empty input)  |

A trailing `\` before Enter also continues the line (shell-style). Pastes
longer than a short threshold collapse to an atomic `[Pasted text #N: X lines]`
placeholder; the original text is what gets submitted.

The footer (always visible, including during approvals) shows
`cwd · git-branch · agent-model · approval-mode · remaining-context-%`.
Context % updates from the server during a task; before the first sample it
shows `—`.

Approval modes (Shift+Tab): `default` asks every time; `accept_edits`
automatically accepts file edits — shell commands and other risky actions
still prompt; `plan` stops after the plan review and does not run subagents.
`/set approval auto` approves a much broader set of actions so the agent runs
with much less interruption: the plan review is auto-implemented, file edits
are accepted, safe shell commands run free, and cautious commands run inside a
sandbox when one is available (macOS Seatbelt this release; otherwise those
commands still prompt). Dangerous commands and background daemons always
prompt. `/set approval bypass` skips every prompt for this
session only — it is never saved. "Always allow (session)" on a command or
file prompt auto-approves matching requests until you quit.

While a task is running, type the next prompt and press Enter to queue it
(FIFO, cap 20). It runs automatically when the current task finishes; Esc
cancels the task and drops the queue. `@path` in a prompt inlines that file
or directory (missing paths become an inline error; `.env` and key files are
refused). A line starting with `!` runs the rest as a local shell command
(stdout/stderr land in history; it is never sent to the agent).

### Optional: TokenSave

`/tokensave` integrates with TokenSave, a separate Rust-based code-intelligence indexer that speeds up workspace search/navigation via MCP. Install it with `cargo install tokensave`, then run `/tokensave init` inside the client.

## Troubleshooting

- **Client won't connect / "certificate fingerprint mismatch"** — the server's cert changed (e.g. you ran `atlas-server --regen-cert`, or pointed at a different server). Run `atlas --trust-fingerprint` to re-pin it.
- **Forgot the server password, or the address/port changed** — run `atlas --reset` to clear the saved password, address, port, and pinned fingerprint, then reconnect through the setup wizard. Or use `atlas --password` / `atlas --address <host>` / `atlas --port <port>` to fix a single value without a full reset.
- **Agent can't reach the model / Ollama errors** — make sure Ollama is installed and you've run `ollama pull <model>` at least once; the server only auto-starts `ollama serve`, it doesn't install Ollama or pull models for you.
- **Not sure which provider config fits your hardware** — run `atlas-detect-hardware` for a suggested vLLM config, or `--write` to apply it directly.
- **`npm install` fails to link `@atlasagents/shared`** — you likely ran it inside `packages/client` or `packages/server` instead of the repo root; see the [Quick Start](#quick-start) note.
- **Port already in use** — pass a different port with `atlas-server` (prompted on first run) or override the client's target with `atlas --port <port>`.

## Architecture (for contributors)

| Workspace           | Path              | What it is                                                                                        |
| ------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `atlasagents`         | `packages/client` | The `atlas` terminal client (Ink/React TUI). Connects to a server, runs the REPL.             |
| `atlasagents-server`  | `packages/server` | The `atlas-server` agent runtime: task orchestration, memory, skills, provider routing, TLS/auth. |
| `@atlasagents/shared` | `packages/shared` | Shared diff/type utilities used by both.                                                          |

- **Orchestration** (`packages/server/src/orchestration`): a lead agent breaks a task into a plan, then a pool of subagents execute subtasks (read/edit files, run commands), escalating back to the lead agent when stuck.
- **Memory** (`packages/server/src/memory`): session continuity, learned preferences, and reusable patterns are extracted from past tasks and consolidated periodically, so the agent improves within a given `atlas-server` data directory over time.
- **Skills** (`user-data/skills/` server-side, `~/.atlasagents/skills/` client-side): markdown instruction files the client syncs to the server; the server picks the most relevant one per task.
- **Providers**: any role (agent/subagent) can be pointed at `ollama` or at a named OpenAI-compatible backend. `atlas-detect-hardware` inspects the host (NVIDIA GPU / AWS Trainium / GCP TPU / CPU) and suggests a `vllm serve` provider configuration.

The directory you launch `atlas-server` from is both its **data root** (`user-data/`, `tls/` get created there) and its **workspace root** (the files it reads/edits). In practice: run it from inside the project you want the agent to work on, and add `user-data/` and `tls/` to that project's `.gitignore`.

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

`packages/client` and `packages/server` depend on `@atlasagents/shared` via a semver range (`^1.0.0`). Inside this workspace, npm links the local `packages/shared` build automatically — no registry publish is required for local development. Outside the workspace, that same version range resolves `@atlasagents/shared` from the npm registry, which is what makes each package independently installable.

`@atlasagents/shared` must be published before `atlasagents` or `atlasagents-server`, since both depend on it by version range:

```bash
npm publish -w @atlasagents/shared
npm publish -w atlasagents-server
npm publish -w atlasagents
```

Once published, each package installs independently:

| Package             | Install                           |
| ------------------- | --------------------------------- |
| `@atlasagents/shared` | `npm install @atlasagents/shared`   |
| `atlasagents-server`  | `npm install -g atlasagents-server` |
| `atlasagents`         | `npm install -g atlasagents`        |
