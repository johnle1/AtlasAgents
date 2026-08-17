# AtlasAgents `_Test_/` — Test Suite

A dedicated folder for **unit**, **integration**, and **system** tests for the AtlasAgents monorepo.
All tests use **Vitest** and are structured as a three-layer pyramid.

**All package tests live here.** Co-located `*.test.ts` files under `packages/client` and
`packages/server` have been consolidated into this folder.

---

## Folder Structure

```
_Test_/
├── unit/                              ← Layer 1: isolated module tests (49 files)
│   ├── agent/orchestration
│   │   ├── agent.test.ts              — Agent.plan search-then-plan loop, budget
│   │   ├── agentConstants.test.ts     — MAX_AGENT_SEARCH_CALLS and friends
│   │   ├── agentHelpers.test.ts       — normaliseSubagentPlan, plan validation
│   │   ├── agentThink.test.ts         — agent think-block parsers (SELF-CHECK, plan sections)
│   │   ├── agentTools.test.ts         — hasAgentSearchTools, AGENT_RETRIEVAL_RULES
│   │   ├── commandClassifier.test.ts  — classifyCommand shell-command safety heuristic
│   │   ├── orchestratorPipelineTypes.test.ts — buildSessionContext, formatPool*, toOrderedResults
│   │   ├── readyQueue.test.ts         — DAG queue: available, take, complete, workerCountFor
│   │   ├── recoverFinishFromThink.test.ts — think-block finish recovery
│   │   ├── subagentRetryHandler.test.ts   — retry/escalation messaging for missing tool calls
│   │   └── taskErrors.test.ts         — formatOrchestratorFailure (agent/subagent model labels)
│   │
│   ├── config / crypto
│   │   ├── configCipherClient.test.ts — client config cipher (AES-256-GCM envelope)
│   │   ├── configCipherServer.test.ts — server config cipher (AES-256-GCM envelope)
│   │   ├── configManagerProvidersCipher.test.ts — provider-secrets encryption, passphrase retry/reset
│   │   ├── configProviders.test.ts    — ConfigManager provider extensions (add/remove/setProvider)
│   │   ├── configUnlock.test.ts       — client unlockOrSetupConfigCipher (first-run, migration, retry)
│   │   ├── configDirMigration.test.ts — copies leftover ~/.agent-cli into ~/.atlasagents
│   │   ├── certificateStore.test.ts   — server TLS certificate store (self-signed cert generation)
│   │   ├── fingerprintStore.test.ts   — TOFU fingerprint pinning for TLS server certs
│   │   └── routerSanitize.test.ts     — stripProviderSecrets (keeps API keys out of responses)
│   │
│   ├── providers / ollama
│   │   ├── messageTranslation.test.ts — server providers/messageTranslation.ts
│   │   ├── modelCapabilities.test.ts  — syncAgentToolSupport / syncSubagentToolSupport
│   │   ├── modelSelectionHandlers.test.ts — client commands/modelSelectionHandlers.ts
│   │   ├── openAiCompatibleAdapter.test.ts — server providers/openAiCompatibleAdapter.ts
│   │   ├── providerHandlers.test.ts   — client commands/providerHandlers.ts
│   │   ├── providerRegistry.test.ts   — server providers/providerRegistry.ts
│   │   └── singleModelAdmin.test.ts   — server providers/singleModelAdmin.ts
│   │
│   ├── tools / workspace
│   │   ├── editFileHandler.test.ts    — accept / decline / revise outcomes
│   │   ├── runCommandHandler.test.ts  — repeated-failure tracking
│   │   ├── shellRunner.test.ts        — timeout behavior
│   │   ├── tokenSaveLabels.test.ts    — server orchestration/tools/tokenSaveLabels.ts
│   │   ├── tokenSaveToolHandler.test.ts — formatMcpData, createTokenSaveToolHandlers
│   │   ├── writeFileHandler.test.ts   — accept / decline / revise outcomes
│   │   └── cwdTracking.test.ts        — persisting agent shell directory changes
│   │
│   ├── client UI / connection
│   │   ├── approvalFlow.test.ts       — client ui/approvalFlow.ts
│   │   ├── bootstrapAbortSignal.test.ts — wireSessionAbortSignal wiring
│   │   ├── commandCatalog.test.ts     — getCommandSuggestions, requiresArgs, label, desc
│   │   ├── connectionHealthCheck.test.ts — runHealthCheck timer cleanup (Bugbot fix)
│   │   ├── historySanitize.test.ts    — sanitizeHistoryLine (pure fn, no mocks)
│   │   ├── mcpBridge.test.ts          — callTokenSaveTool, formatToolContentAsString
│   │   ├── mcpToolSchema.test.ts      — mcpToolToAtlasSchema mapping
│   │   ├── spinnerSync.test.ts        — spinnerForStatusFrame (all AGENT_THINKING_STAGES)
│   │   ├── statusVisual.test.ts       — resolveWorkerVisual, resolveQueueVisual, etc.
│   │   ├── taskBoardLayout.test.ts    — wrapTaskLine, buildTaskBoardLines, borderWidth
│   │   ├── tokenSaveClient.test.ts    — enqueueTokenSaveOperation, hasTokenSaveIndex, allowlist
│   │   └── tokenSaveHandlers.test.ts  — syncTokenSaveTools, handleTokenSave, printTokenSaveInitTip
│   │
│   ├── misc
│   │   ├── authMiddleware.test.ts     — AuthMiddleware password validation, no-unauth-mode
│   │   ├── detectHardware.test.ts     — server hardware/detectHardware.ts
│   │   ├── diffEngine.test.ts         — packages/shared/src/diffEngine.ts
│   │   ├── frames.test.ts             — encodeFrame / decodeFrame round-trip
│   │   ├── skillManager.test.ts       — delete, selectForTask
│   │   └── skills.test.ts             — skill name validation (path traversal guard)
│   │
│   └── bridge/
│       └── state.test.ts              — all get/set bridge state accessors
│
├── integration/                       ← Layer 2: wires real modules, mocks at the boundary (7 files)
│   ├── spinnerBridge.test.ts          — frame → spinnerForStatusFrame → setSpinner → hook
│   ├── commandCatalogFlow.test.ts     — full autocomplete pipeline round-trip
│   ├── tlsHandshakeFlow.test.ts       — real TLS 1.3 RSocket handshake, fingerprint enforcement
│   ├── tofuFingerprintFlow.test.ts    — TOFU pinning with the REAL disk-backed fingerprint store
│   ├── providerSecretsFlow.test.ts    — provider API keys never leak through routeCommand
│   ├── routerCommandFlow.test.ts      — config.setModel / config.set / models.delete via the real Router
│   └── orchestratorPipelineFlow.test.ts — full runTask pipeline (plan → subagent pool → combine)
│
├── system/                            ← Layer 3: spawns the compiled binary (2 files)
│   ├── cli.e2e.test.ts                — --help, flags, invalid/boundary ports, bad server env
│   └── cliConfigLifecycle.e2e.test.ts — config bootstrap + encryption-at-rest on a real ~/.atlasagents/
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

System tests spawn the compiled `atlas` binary. Build it first:

```bash
cd packages/client
npm run build
```

System tests skip gracefully (`it.skip`) when `dist/index.js` is missing. `npm run test:e2e`
(see below) builds automatically first, so E2E can't pass vacuously by skipping in CI.

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
npm run test:system        # only _Test_/system/** — skips if dist/ is missing
npm run test:e2e           # builds packages/client first, THEN runs system/** — never skips silently

# Watch mode (re-runs on save)
npm run test:watch

# Coverage report (unit + integration only; system excluded)
npm run test:coverage
```

---

## Layer Reference

| Layer | Scope | Mocks | Speed | Count |
|-------|-------|-------|-------|-------|
| Unit | 1 function / module | Mock all external deps | ms | 49 files |
| Integration | Multiple real modules wired | Mock only the outermost boundary (network, UI hooks) | ~100ms–1s | 7 files |
| System | Compiled CLI binary | Nothing | Seconds | 2 files |

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

### `@atlasagents/shared` aliasing

Rather than building the shared package first, the vitest config maps the import directly
to the TypeScript source:

```typescript
{ find: '@atlasagents/shared', replacement: '../packages/shared/src/index.ts' }
```

### Testability refactors for Bugbot fixes

- `Connection.healthCheckRunner` — `@internal` getter exposing `runHealthCheck` for timer
  cleanup tests without making the method public API.
- `wireSessionAbortSignal` — pure function extracted from `BootstrapApp.tsx` so abort-signal
  wiring is testable without `ink-testing-library`.

### Integration tests mock at the boundary, not `deps.agent`

`orchestratorPipelineFlow.test.ts` fakes `IProviderRegistry.getRoleClient` (the Ollama HTTP
boundary) rather than the `Agent`/`Subagent` classes themselves — `runOrchestratorPipeline`
reconstructs its own `Agent`/`Subagent` from the provider registry internally (its `deps.agent`
parameter is intentionally unused), so faking one level lower exercises the real planning,
retry/escalation, and tool-call logic end-to-end.

### `agentModel`/`subagentModel` naming discipline

This codebase went through an "advisor" → "agent"/"subagent" rename, and a class of bugs
where the two roles' models/temperatures/tool-support flags got crossed wasn't caught by any
single module's unit tests — only the wiring between modules was wrong. Several integration
tests exist specifically to guard against that class of regression recurring
(`routerCommandFlow.test.ts`'s `config.setModel` tests, `orchestratorPipelineFlow.test.ts`'s
"regression guard" describe block). If you touch code that resolves per-role model/config
values, run these two files.

---

## Adding New Tests

1. **Unit test**: create `unit/<module-name>.test.ts`, import directly from
   `../../packages/<client|server|shared>/src/...`.
2. **Integration test**: create `integration/<feature>.test.ts`, wire multiple real
   modules together, mock only the true external boundary (network, UI callbacks).
3. **System test**: create `system/<scenario>.e2e.test.ts`, use `execa` + `strip-ansi`,
   add the `itWhenBuilt` guard pattern.

---

## CI Integration

See `.github/workflows/test.yml` at the repo root. Summary:

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
      - run: cd _Test_ && npm install
      - run: cd _Test_ && npm run test:e2e   # builds packages/client, then runs system/**
```
