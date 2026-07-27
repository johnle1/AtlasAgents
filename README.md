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

`packages/client` and `packages/server` depend on `@loopycode/shared` via a semver range (`^0.1.0`). Inside this workspace, npm links the local `packages/shared` build automatically — no registry publish is required for local development. Outside the workspace, that same version range resolves `@loopycode/shared` from the npm registry, which is what makes each package independently installable.

## Packages

Each package below is published and installable on its own — installing `loopycode-server` does not pull in the client, and vice versa. Both depend on `@loopycode/shared`, which npm resolves from the registry automatically.

| Workspace | Path | Description | Install |
|-----------|------|-------------|---------|
| `@loopycode/shared` | `packages/shared` | Shared diff and types | `npm install @loopycode/shared` |
| `loopycode-server` | `packages/server` | RSocket server | `npm install -g loopycode-server` |
| `loopycode` | `packages/client` | CLI client | `npm install -g loopycode` |

### Publish order

`@loopycode/shared` must be published before `loopycode` or `loopycode-server`, since both depend on it by version range:

```bash
npm publish -w @loopycode/shared
npm publish -w loopycode-server
npm publish -w loopycode
```
