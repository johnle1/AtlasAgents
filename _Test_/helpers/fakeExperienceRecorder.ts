/**
 * Shared test double for {@link IExperienceRecorder}.
 *
 * @remarks
 * Handler tests only ever assert on one or two recorder calls, but the
 * interface has seven methods — stubbing a subset and casting hides the gap
 * until the interface changes. This factory implements every method as a
 * `vi.fn()`, so `satisfies` catches drift at compile time while callers keep
 * full `Mock` typing for assertions (`expect(recorder.logCommand)...`).
 */

import { vi } from "vitest";
import type { IExperienceRecorder } from "../../packages/server/src/orchestration/interfaces.js";

/**
 * Builds a fully-stubbed experience recorder whose methods are all spies.
 *
 * @returns A recorder assignable to `IExperienceRecorder` with `Mock` members.
 */
export const fakeExperienceRecorder = () =>
  ({
    start: vi.fn(async () => {}),
    logRead: vi.fn(),
    logWrite: vi.fn(),
    logCommand: vi.fn(),
    logEscalation: vi.fn(),
    logUserEdit: vi.fn(),
    finish: vi.fn(async () => {}),
  }) satisfies IExperienceRecorder;
