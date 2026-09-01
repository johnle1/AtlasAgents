/**
 * Server shutdown sequence, split out of `server/index.ts`.
 *
 * @remarks
 * Kept in its own module (rather than inline in `index.ts`) specifically so
 * it can be unit-tested: `index.ts` runs `main()` as a top-level side effect
 * on import (`void main().catch(...)`), which parses `process.argv` and can
 * call `process.exit`/prompt on stdin the moment the module loads — not
 * something a test should trigger just to reach this logic. This module has
 * no side effects of its own; every dependency is passed in.
 */

import type { AppContainer } from "../container/index.js";

/** Milliseconds to wait for a clean shutdown before force-exiting. */
export const SHUTDOWN_WATCHDOG_MS = 3_000;

/**
 * Tears down one connection's per-client resources.
 *
 * @remarks
 * The single teardown routine for a `PerConnection` — shared by the normal
 * per-disconnect callback (fired when a client disconnects while the server
 * keeps running) and by {@link performShutdown} (fired once per survivor when
 * the whole process is going down). Removes the entry from
 * `brokerByRequester` so it isn't disposed twice.
 */
export const disposeConnection = (app: AppContainer, requesterId: string): void => {
  const perConnection = app.brokerByRequester.get(requesterId);
  if (perConnection) {
    perConnection.planBroker.dispose();
    perConnection.workspace.dispose();
    perConnection.terminal.dispose();
    app.brokerByRequester.delete(requesterId);
  }
  // The placement reporter is a process-lifetime singleton that dedupes
  // by requesterId, so its state has to be released here too — otherwise
  // it grows by an entry per connection for as long as the server runs.
  app.modelPlacementReporter.forgetScope(requesterId);
};

/**
 * Runs the server's shutdown sequence: cancel in-flight work, stop accepting
 * connections, release every connection's resources, stop Ollama if this
 * process started it, then exit.
 *
 * @remarks
 * Order matters — **abort before close**. `server.stop()` only stops
 * *accepting new* connections (Node's `net.Server.close()` does not drop
 * already-open sockets), so a connected client mid-task would otherwise keep
 * the event loop alive on its own even after `stop()` runs. Aborting first
 * unblocks any in-flight `ollama.chat`/`chatWithTools` call immediately —
 * `agentTurn.ts` and `reasoner.ts` both propagate `AbortError` rather than
 * swallowing it, so cancellation is fast even against a slow local model.
 *
 * Every dependency is injected (including `exit`) so the ordering can be
 * asserted in a unit test without real signals or a real `process.exit`.
 *
 * @param exit - Defaults to `process.exit`; override in tests.
 */
export const performShutdown = (
  app: AppContainer,
  server: { stop: () => void; abortAll: () => void },
  ollamaLifecycle: { startedByServer: boolean; stop: () => void },
  exit: (code: number) => void = process.exit,
): void => {
  const watchdog = setTimeout(() => exit(1), SHUTDOWN_WATCHDOG_MS);
  watchdog.unref();

  server.abortAll();
  server.stop();
  for (const requesterId of [...app.brokerByRequester.keys()]) {
    disposeConnection(app, requesterId);
  }
  if (ollamaLifecycle.startedByServer) {
    ollamaLifecycle.stop();
  }

  clearTimeout(watchdog);
  exit(0);
};
