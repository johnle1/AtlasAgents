# LoopyCode `_Test_/` — Test Suite

A dedicated folder for **unit**, **integration**, and **system** tests for the LoopyCode monorepo.
All tests use **Vitest** and are structured as a three-layer pyramid.

**All package tests live here.** Co-located `*.test.ts` files under `packages/client` and
`packages/server` have been consolidated into this folder.

---

## Folder Structure

```
_Test_/
├── unit/                              ← Layer 1: isolated module tests
│   ├── agent.test.ts                — Advisor.plan search-then-plan loop, budget
│   ├── agentConstants.test.ts       — MAX_ADVISOR_LOOPS, MAX_ADVISOR_SEARCH_CALLS
│   ├── agentTools.test.ts           — hasAdvisorSearchTools, ADVISOR_RETRIEVAL_RULES
│   ├── bootstrapAbortSignal.test.ts   — wireSessionAbortSignal wiring
│   ├── commandCatalog.test.ts         — getCommandSuggestions, requiresArgs, label, desc
│   ├── connectionHealthCheck.test.ts  — runHealthCheck timer cleanup (Bugbot fix)
│   ├── diffEngine.test.ts             — computeDiff, formatDiffPlain, getDiffDisplayLines
│   ├── frames.test.ts                 — encodeFrame / decodeFrame round-trip
│   ├── historySanitize.test.ts        — sanitizeHistoryLine (pure fn, no mocks)
│   ├── mcpBridge.test.ts              — callTokenSaveTool, formatToolContentAsString
│   ├── mcpToolSchema.test.ts          — mcpToolToLoopySchema mapping
│   ├── orchestratorPipelineTypes.test.ts — buildSessionContext, formatPool*, toOrderedResults
│   ├── readyQueue.test.ts             — DAG queue: available, take, complete, workerCountFor
│   ├── skillManager.test.ts           — delete, selectForTask
│   ├── spinnerSync.test.ts            — spinnerForStatusFrame (all ADVISOR_THINKING_STAGES)
│   ├── statusVisual.test.ts           — resolveWorkerVisual, resolveQueueVisual, etc.
│   ├── taskBoardLayout.test.ts        — wrapTaskLine, buildTaskBoardLines, borderWidth
│   ├── tokenSaveClient.test.ts        — enqueueTokenSaveOperation, hasTokenSaveIndex,
│   │                                    isTokenSaveOnPath, listCuratedTools, allowlist
│   ├── tokenSaveHandlers.test.ts      — syncTokenSaveTools, handleTokenSave, printTokenSaveInitTip
│   ├── tokenSaveToolHandler.test.ts   — formatMcpData, createTokenSaveToolHandlers
│   └── bridge/
│       └── state.test.ts              — all get/set bridge state accessors
│
├── integration/                       ← Layer 2: wires real modules, mocks at boundary
│   ├── spinnerBridge.test.ts          — frame → spinnerForStatusFrame → setSpinner → hook
│   └── commandCatalogFlow.test.ts     — full autocomplete pipeline round-trip
│
├── system/                            ← Layer 3: spawns the compiled binary
│   └── cli.e2e.test.ts                — --help, bad server env, exit codes, no-hang
│
├── vitest.config.ts                   — Vitest + Vite alias config
├── package.json                       — devDeps (vitest, execa, strip-ansi)
├── tsconfig.json                      — TypeScript config for the _Test_ folder
└── README.md                          — this file
```

### Removed co-located tests

These files were deleted after their cases moved here:

| Deleted file | Replaced by |
|---|---|
| `packages/client/src/mcp/tokenSaveClient.test.ts` | `unit/tokenSaveClient.test.ts` |
| `packages/client/src/ui/spinnerSync.test.ts` | `unit/spinnerSync.test.ts` |
| `packages/client/src/ui/taskBoardLayout.test.ts` | `unit/taskBoardLayout.test.ts` |
| `packages/server/src/orchestration/agent/agent.test.ts` | `unit/agent.test.ts` |
| `packages/server/src/orchestration/mcp/mcpToolSchema.test.ts` | `unit/mcpToolSchema.test.ts` |
| `packages/server/src/orchestration/readyQueue.test.ts` | `unit/readyQueue.test.ts` |
| `packages/server/src/orchestration/orchestrator/orchestratorPipelineTypes.test.ts` | `unit/orchestratorPipelineTypes.test.ts` |
| `packages/server/src/skills/skillManager.test.ts` | `unit/skillManager.test.ts` |

`packages/server` `npm test` now prints a pointer to `_Test_/`.

---

## Prerequisites

### Unit & Integration tests — no build needed

Unit and integration tests run against the **TypeScript source** directly (Vitest transforms
them on-the-fly). You do NOT need to run `tsc` first.

### System tests — build required

System tests spawn the compiled `loopy` binary. Build it first:

```bash
cd packages/client
npm run build
```

System tests skip gracefully (`it.skip`) when `dist/index.js` is missing.

---

## Running tests

From the `_Test_/` directory:

```bash
# Install test dependencies (first time only)
npm install

# Run all layers
npm test

# Run each layer independently
npm run test:unit          # only _Test_/unit/**
npm run test:integration   # only _Test_/integration/**
npm run test:system        # only _Test_/system/** (needs dist/)

# Watch mode (re-runs on save)
npm run test:watch

# Coverage report (unit + integration only; system excluded)
npm run test:coverage
```

---

## Layer Reference

| Layer | Scope | Mocks | Speed | Count |
|-------|-------|-------|-------|-------|
| Unit | 1 function / module | Mock all external deps | ms | Hundreds |
| Integration | Multiple real modules wired | Mock only the outermost boundary (UI hooks) | ~100ms | Dozens |
| System | Compiled CLI binary | Nothing | Seconds | A handful |

---

## Key Design Decisions

### Single test home

All unit tests for `packages/client`, `packages/server`, and `packages/shared` run from
`_Test_/`. This gives one `npm test` entry point and consistent Vitest tooling.

### `.js` extension resolution

Client and server source imports use `.js` extensions for Node ESM compliance. Vitest
resolves these to `.ts` files automatically via the regex alias in `vitest.config.ts`:

```typescript
{ find: /^(.+)\.js$/, replacement: '$1' }
```

### `@loopycode/shared` aliasing

Rather than building the shared package first, the vitest config maps the import directly
to the TypeScript source:

```typescript
{ find: '@loopycode/shared', replacement: '../packages/shared/src/index.ts' }
```

### Testability refactors for Bugbot fixes

- `Connection.healthCheckRunner` — `@internal` getter exposing `runHealthCheck` for timer
  cleanup tests without making the method public API.
- `wireSessionAbortSignal` — pure function extracted from `BootstrapApp.tsx` so abort-signal
  wiring is testable without `ink-testing-library`.

---

## Adding New Tests

1. **Unit test**: create `unit/<module-name>.test.ts`, import directly from
   `../../packages/<client|server|shared>/src/...`.
2. **Integration test**: create `integration/<feature>.test.ts`, wire multiple real
   modules together, mock only UI callbacks.
3. **System test**: create `system/<scenario>.e2e.test.ts`, use `execa` + `strip-ansi`,
   add the `itWhenBuilt` guard pattern.

---

## CI Integration

Recommended GitHub Actions workflow order:

```yaml
jobs:
  unit-and-integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install          # workspace root
      - run: cd _Test_ && npm install
      - run: cd _Test_ && npm run test:unit
      - run: cd _Test_ && npm run test:integration

  system:
    needs: unit-and-integration
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
      - run: cd packages/client && npm run build
      - run: cd _Test_ && npm install
      - run: cd _Test_ && npm run test:system
```
