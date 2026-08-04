/**
 * Unit tests — container factories and composition root
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createContainer } from "../../../../packages/server/src/container/index.js";
import { createServices } from "../../../../packages/server/src/container/serviceFactory.js";
import { createPerConnection } from "../../../../packages/server/src/container/perConnectionFactory.js";
import { ClientBridge } from "../../../../packages/server/src/transport/clientBridge.js";
import { AgentOrchestrator } from "../../../../packages/server/src/orchestration/orchestrator/orchestrator.js";

const tempRoots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "loopy-container-"));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("createServices", () => {
  it("returns initialized services for a temp data root", async () => {
    const root = await makeRoot();
    const services = createServices({ dataRoot: root, ollamaBaseUrl: "http://127.0.0.1:11434" });

    expect(services.ollama).toBeDefined();
    expect(services.config).toBeDefined();
    expect(services.orchestrator).toBeInstanceOf(AgentOrchestrator);
    expect(services.experienceRecorder).toBeDefined();
    expect(services.session).toBeDefined();
  });
});

describe("createContainer", () => {
  it("wires services and exposes factory helpers", async () => {
    const root = await makeRoot();
    const app = createContainer({
      dataRoot: root,
      ollamaBaseUrl: "http://127.0.0.1:11434",
      getClientPeer: vi.fn(),
    });

    expect(app.orchestrator).toBeInstanceOf(AgentOrchestrator);
    expect(typeof app.createPerConnection).toBe("function");
    expect(typeof app.buildRouter).toBe("function");
    expect(typeof app.scheduleConsolidation).toBe("function");
    expect(app.brokerByRequester).toBeInstanceOf(Map);

    const router = app.buildRouter();
    expect(router).toBeDefined();
    expect(typeof router.routeCommand).toBe("function");
  });
});

describe("createPerConnection", () => {
  it("creates isolated workspace, terminal, and plan broker", () => {
    const bridge = new ClientBridge(vi.fn());
    const emit = vi.fn();
    const conn = createPerConnection({ clientBridge: bridge }, "req-1", emit);

    expect(conn.planBroker).toBeDefined();
    expect(conn.workspace).toBeDefined();
    expect(conn.terminal).toBeDefined();
    expect(typeof conn.resolvePlan).toBe("function");
    expect(typeof conn.rebindStreamEmit).toBe("function");

    conn.workspace.bindRequester("req-1");
    conn.terminal.bindRequester("req-1");
    expect(typeof conn.workspace.readFile).toBe("function");
    expect(typeof conn.terminal.run).toBe("function");
  });
});

describe("AgentOrchestrator constructor", () => {
  it("constructs with mocked dependencies", () => {
    const root = process.cwd();
    const services = createServices({ dataRoot: root });
    expect(services.orchestrator).toBeInstanceOf(AgentOrchestrator);
    expect(typeof services.orchestrator.runTask).toBe("function");
  });
});
