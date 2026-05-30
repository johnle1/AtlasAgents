# LoopyCode

Monorepo for the LoopyCode CLI client, RSocket server, and shared utilities.

## Install and build

Run **`npm install` from the repository root** (not from `packages/client`, `packages/server`, or `packages/shared`). The root `package.json` uses npm workspaces (`packages/*`), which includes `packages/shared` as `@loopycode/shared`. Installing inside a single package folder will not link the local shared package correctly.

```bash
cd /path/to/LoopyCode
npm install
npm run build -w @loopycode/shared
npm run build -w loopycode-server
npm run build -w loopycode
```

`packages/client` and `packages/server` depend on `@loopycode/shared` via `file:../shared`, so no npm registry publish is required for local development.

## Packages

| Workspace | Path | Description |
|-----------|------|-------------|
| `@loopycode/shared` | `packages/shared` | Shared diff and types |
| `loopycode-server` | `packages/server` | RSocket server |
| `loopycode` | `packages/client` | CLI client |
