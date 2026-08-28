/**
 * Unit tests — modelSelectionHandlers.ts's buildPlanCarriedOverMessage
 *
 * @remarks
 * The plan-handoff feature: after a successful `/set agent` model switch,
 * the client reports whatever checklist progress is still carried over on
 * the connection (the server picks it up for real via agentTurn.ts's
 * resume-block prompt injection — see agentTurn.test.ts's "plan handoff"
 * suite). This is the pure formatting half of that feature.
 */

import { describe, expect, it } from "vitest";
import { buildPlanCarriedOverMessage } from "../../../../packages/client/src/commands/modelSelectionHandlers.js";
import type { PlanStepState } from "../../../../packages/client/src/ui/types.js";

describe("buildPlanCarriedOverMessage", () => {
  it("returns null when there is no active plan", () => {
    expect(buildPlanCarriedOverMessage([])).toBeNull();
  });

  it("returns null once every step is already done", () => {
    const steps: PlanStepState[] = [
      { id: 1, text: "a", status: "done" },
      { id: 2, text: "b", status: "done" },
    ];
    expect(buildPlanCarriedOverMessage(steps)).toBeNull();
  });

  it("reports the done count and names the next unfinished step", () => {
    const steps: PlanStepState[] = [
      { id: 1, text: "read the config parser", status: "done" },
      { id: 2, text: "wire the flag into routerBuilder", status: "in_progress" },
      { id: 3, text: "update the tests", status: "pending" },
    ];
    expect(buildPlanCarriedOverMessage(steps)).toBe(
      "Plan carried over — 1/3 done. Next: wire the flag into routerBuilder.",
    );
  });

  it("skips a failed step when picking the next one to name", () => {
    const steps: PlanStepState[] = [
      { id: 1, text: "a", status: "failed" },
      { id: 2, text: "b", status: "pending" },
    ];
    expect(buildPlanCarriedOverMessage(steps)).toBe(
      "Plan carried over — 0/2 done. Next: b.",
    );
  });

  it("omits the 'Next:' clause when every remaining step is failed", () => {
    const steps: PlanStepState[] = [
      { id: 1, text: "a", status: "done" },
      { id: 2, text: "b", status: "failed" },
    ];
    expect(buildPlanCarriedOverMessage(steps)).toBe("Plan carried over — 1/2 done.");
  });
});
