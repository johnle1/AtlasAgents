/**
 * <Summary>
 * What it does:
 *   Passive observer that records task activity in memory and persists finished
 *   experiences to user-data/experiences/ without blocking the user on learning.
 *
 * How it fits in the system:
 *   Implements IExperienceRecorder; called by AdvisorOrchestrator and future
 *   workspace/terminal/agent hooks. Provides fire-and-forget learning that doesn't
 *   block the user's workflow while pattern extraction runs in the background.
 *
 * Dependencies:
 *   - PatternExtractor — fire-and-forget after finish.
 *   - Optional SessionManager — append session summary when present.
 *
 * Dependants:
 *   - AdvisorOrchestrator.runTask.
 * </Summary>
 */

// ===== CRYPTO IMPORTS =====
import { randomUUID } from "node:crypto";

// ===== FILESYSTEM IMPORTS =====
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ===== INTERFACE IMPORTS =====
import type {
  IExperienceRecorder,
  IPatternExtractor,
} from "../../orchestration/interfaces.js";

// ===== TYPE DEFINITION IMPORTS =====
import type { OrchestrationOutcome } from "../../orchestration/types.js";
import type {
  CommandOutput,
  ExperienceRecord,
  SessionSummary,
  TaskOutcome,
} from "../types.js";

// ===== CONSTANTS IMPORTS =====
import { EXPERIENCES_DIR, SNAPSHOTS_DIR } from "./experienceConstants.js";

// ===== HELPER FUNCTIONS IMPORTS =====
import { deriveOutcome, ensureDir } from "./experienceHelpers.js";

/**
 * <Summary>
 * What it does:
 *   Records one orchestrated task lifecycle in memory, persists JSON on finish,
 *   and triggers pattern extraction without blocking the user.
 *
 * How it fits in the system:
 *   Brackets AdvisorOrchestrator.runTask; future workspace/terminal/agent code
 *   call log* methods between start and finish.
 *
 * Dependencies:
 *   - IPatternExtractor — required at construction.
 *   - Optional sessionManager.append — session file updates.
 *
 * Dependants:
 *   - AdvisorOrchestrator — start/finish only today.
 * </Summary>
 */
export class ExperienceRecorder implements IExperienceRecorder {
  /**
   * Base directory for user-data paths (defaults to process.cwd()).
   * Used as the root for constructing paths to experiences and snapshots directories.
   */
  private readonly rootDirectory: string;

  /**
   * Absolute path to user-data/experiences/.
   * Location where finished task records are persisted as JSON files.
   */
  private readonly experiencesDirectory: string;

  /**
   * Absolute path to user-data/snapshots/.
   * Location where temporary snapshots are stored for rollback capability.
   */
  private readonly snapshotsDirectory: string;

  /**
   * Active in-flight records keyed by taskId until finish removes them.
   * Map stores ExperienceRecord objects for tasks currently in progress.
   * Key is the taskId (UUID), value is the in-memory record object.
   */
  private readonly activeRecords = new Map<string, ExperienceRecord>();

  /**
   * <Summary>
   * What it does:
   *   Resolves storage paths and stores collaborators for finish-side effects.
   *
   * How it does it (step by step):
   *   1. Accept optional rootDir (else use process.cwd()).
   *   2. Join rootDir with EXPERIENCES_DIR and SNAPSHOTS_DIR.
   *   3. Store patternExtractor and optional sessionManager from deps.
   *
   * Parameters:
   *   @param {{ rootDir?: string; patternExtractor: IPatternExtractor; sessionManager?: { append: (summary: SessionSummary) => Promise<void> | void } }} deps — Injected services.
   *
   * Returns:
   *   void — instance fields are set for later method calls.
   *
   * Dependants:
   *   - All ExperienceRecorder instance methods.
   * </Summary>
   */
  constructor(
    private readonly dependencies: {
      rootDir?: string;
      patternExtractor: IPatternExtractor;
      sessionManager?: {
        append: (summary: SessionSummary) => Promise<void> | void;
      };
    },
  ) {
    // Step 1: Resolve data root (where user-data/ lives)
    this.rootDirectory = dependencies.rootDir ?? process.cwd();
    // Step 2: Build absolute paths for experience files and snapshot cleanup
    this.experiencesDirectory = path.join(this.rootDirectory, EXPERIENCES_DIR);
    this.snapshotsDirectory = path.join(this.rootDirectory, SNAPSHOTS_DIR);
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Opens a new in-memory experience record when a task begins (no disk write).
   *
   * How it does it (step by step):
   *   1. Build an ExperienceRecord with taskId, task text, and startTime.
   *   2. Initialise all log arrays as empty.
   *   3. Set outcome, duration, and sessionSummary to null until finish.
   *   4. Store the record in this.records keyed by taskId.
   *
   * Parameters:
   *   @param {string} taskId — Unique id for this orchestration run (UUID).
   *   @param {string} taskText — Original user task string.
   *
   * Returns:
   *   @returns {Promise<void>} — Completes when the record is in the Map.
   *
   * Dependencies:
   *   None.
   *
   * Dependants:
   *   - AdvisorOrchestrator.runTask — before advisor.plan.
   * </Summary>
   */
  start = async (taskId: string, taskText: string): Promise<void> => {
    // Step 1–3: Create the empty record shell per Part 18 spec
    const record: ExperienceRecord = {
      taskId,
      task: taskText,
      startTime: Date.now(),
      filesRead: [],
      filesWritten: [],
      commandsRun: [],
      escalations: [],
      userEdits: [],
      outcome: null,
      duration: null,
      sessionSummary: null,
    };
    // Step 4: Register so log* and finish can find this task
    this.activeRecords.set(taskId, record);
  };

  /**
   * <Summary>
   * What it does:
   *  whenever a model reads a file, this logs the read event.
   *
   * How it does it (step by step):
   *   1. Look up the record by taskId in this.records.
   *   2. If missing, return immediately (defensive no-op).
   *   3. Push { path, timestamp } onto filesRead.
   *
   * Parameters:
   *   @param {string} taskId — Task id from start().
   *   @param {string} filePath — Path that was read.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependants:
   *   - Future WorkspaceManager.read paths.
   * </Summary>
   */
  logRead = (taskId: string, filePath: string): void => {
    // Step 1: Find in-flight record
    const record = this.activeRecords.get(taskId);
    // Step 2: Unknown or already finished task — ignore silently
    if (!record) {
      return;
    }
    // Step 3: Append read entry with ISO timestamp for audit ordering
    record.filesRead.push({
      path: filePath,
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * <Summary>
   * What it does:
   *   Appends one file write event with diff text to the active task record.
   *
   * How it does it (step by step):
   *   1. Look up the record by taskId.
   *   2. If missing, return without error.
   *   3. Push { path, diff, timestamp } onto filesWritten.
   *
   * Parameters:
   *   @param {string} taskId — Task id from start().
   *   @param {string} filePath — Path that was written.
   *   @param {string} diffContent — Unified diff or change summary.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependants:
   *   - Future WorkspaceManager.write paths.
   * </Summary>
   */
  logWrite = (taskId: string, filePath: string, diffContent: string): void => {
    // Step 1: Find in-flight record
    const record = this.activeRecords.get(taskId);
    // Step 2: No active record — no-op
    if (!record) {
      return;
    }
    // Step 3: Store path and diff for PatternExtractor and replay
    record.filesWritten.push({
      path: filePath,
      diff: diffContent,
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * <Summary>
   * What it does:
   *   Appends one terminal command execution to the active task record.
   *
   * How it does it (step by step):
   *   1. Look up the record by taskId.
   *   2. If missing, return immediately.
   *   3. Push command, stdout, stderr, exitCode, and timestamp onto commandsRun.
   *
   * Parameters:
   *   @param {string} taskId — Task id from start().
   *   @param {string} command — Shell command string that ran.
   *   @param {CommandOutput} output — Captured stdout, stderr, and exit code.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependants:
   *   - Future TerminalExecutor after command completes.
   * </Summary>
   */
  logCommand = (
    taskId: string,
    command: string,
    output: CommandOutput,
  ): void => {
    // Step 1: Find in-flight record
    const record = this.activeRecords.get(taskId);
    // Step 2: No active record — no-op
    if (!record) {
      return;
    }
    // Step 3: Persist full command output for experience replay
    record.commandsRun.push({
      command,
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: output.exitCode,
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * <Summary>
   * What it does:
   *   Appends one agent escalation and advisor resolution pair to the record.
   *
   * How it does it (step by step):
   *   1. Look up the record by taskId.
   *   2. If missing, return without error.
   *   3. Push { reason, guidance, timestamp } onto escalations.
   *
   * Parameters:
   *   @param {string} taskId — Task id from start().
   *   @param {string} reason — Why the agent escalated (ESCALATE reason).
   *   @param {string} guidance — Advisor text that unblocked the agent.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependants:
   *   - Future Agent.run escalation handler.
   *   - PatternExtractor — builds fix rules from escalations.
   * </Summary>
   */
  logEscalation = (taskId: string, reason: string, guidance: string): void => {
    // Step 1: Find in-flight record
    const record = this.activeRecords.get(taskId);
    // Step 2: No active record — no-op
    if (!record) {
      return;
    }
    // Step 3: Store escalation pair for downstream fix-rule extraction
    record.escalations.push({
      reason,
      guidance,
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * <Summary>
   * What it does:
   *   Appends one user edit (before/after agent output) for style preference learning.
   *
   * How it does it (step by step):
   *   1. Look up the record by taskId.
   *   2. If missing, return immediately.
   *   3. Push { path, before, after, timestamp } onto userEdits.
   *
   * Parameters:
   *   @param {string} taskId — Task id from start().
   *   @param {string} filePath — File the user edited.
   *   @param {string} before — Content before user change.
   *   @param {string} after — Content after user change.
   *
   * Returns:
   *   void — called for side effects only.
   *
   * Dependants:
   *   - Future client/workspace user-edit detection.
   *   - PatternExtractor — builds style rules from userEdits.
   * </Summary>
   */
  logUserEdit = (
    taskId: string,
    filePath: string,
    before: string,
    after: string,
  ): void => {
    // Step 1: Find in-flight record
    const record = this.activeRecords.get(taskId);
    // Step 2: No active record — no-op
    if (!record) {
      return;
    }
    // Step 3: Capture before/after for style preference rules
    record.userEdits.push({
      path: filePath,
      before,
      after,
      timestamp: new Date().toISOString(),
    });
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Finalises the task record: sets outcome and duration, writes JSON to disk,
   *   optionally cleans snapshots and appends session summary, then triggers
   *   PatternExtractor without awaiting learning.
   *
   * How it does it (step by step):
   *   1. Look up the record; return if taskId unknown.
   *   2. Derive TaskOutcome from orchestration.ok and logged activity.
   *   3. Set duration, sessionSummary, ok, and error on the record.
   *   4. Write user-data/experiences/<timestamp>-<taskId>.json via temp file + rename.
   *   5. On success only, schedule snapshot cleanup (background, non-blocking).
   *   6. On success or partial, call sessionManager.append when summary and manager exist.
   *   7. Remove the record from this.records to free memory.
   *   8. Fire-and-forget patternExtractor.extract(record).
   *   9. Return (user never waits for steps 5–8 completion).
   *
   * Parameters:
   *   @param {string} taskId — Same id passed to start().
   *   @param {OrchestrationOutcome} outcome — Plan, results, ok flag, optional error.
   *   @param {SessionSummary} [sessionSummary] — Optional blob for session file append.
   *
   * Returns:
   *   @returns {Promise<void>} — Resolves after persist attempt; does not await extraction.
   *
   * Dependencies:
   *   - deriveOutcome, ensureDir, fs.writeFile, fs.rename.
   *   - cleanupSnapshots, deps.sessionManager, deps.patternExtractor.
   *
   * Dependants:
   *   - AdvisorOrchestrator.runTask — finally block.
   * </Summary>
   */
  finish = async (
    taskId: string,
    outcome: OrchestrationOutcome,
    sessionSummary?: SessionSummary,
  ): Promise<void> => {
    // Step 1: Load in-memory record (missing if start never ran or double-finish)
    const record = this.activeRecords.get(taskId);
    if (!record) {
      return;
    }

    // Step 2: Map orchestrator result + logs to success | partial | failure
    const taskOutcome = deriveOutcome(outcome, record);
    // Step 3: Fill final fields on the record before serialisation
    record.outcome = taskOutcome;
    record.duration = Date.now() - record.startTime;
    const summary: SessionSummary = sessionSummary ?? {
      task: record.task,
      filesWritten: record.filesWritten.map((w) => w.path),
      commandsRun: record.commandsRun.map((c) => c.command),
      outcome: taskOutcome,
    };
    record.sessionSummary = summary;
    record.ok = outcome.ok;
    record.error = outcome.error;

    // Step 4a: Build destination filename (timestamp prefix aids sort-by-time)
    const timestampValue = Date.now();
    const fileName = `${timestampValue}-${taskId}.json`;
    const destinationPath = path.join(this.experiencesDirectory, fileName);

    try {
      // Step 4b: Ensure experiences directory exists
      await ensureDir(this.experiencesDirectory);
      // Step 4c: Write to a unique temp file first (atomic publish pattern)
      const tempPath = path.join(
        this.experiencesDirectory,
        `.experience-${randomUUID()}.tmp`,
      );
      const jsonPayload = `${JSON.stringify(record, null, 2)}\n`;
      await fs.writeFile(tempPath, jsonPayload, "utf-8");
      // Step 4d: Rename temp to final name — readers never see a half-written file
      await fs.rename(tempPath, destinationPath);
    } catch (error) {
      // Persist failure must not break orchestrator; log and continue cleanup/learning
      console.error(
        "[ExperienceRecorder] failed to persist experience:",
        error,
      );
    }

    // Step 5: Successful tasks no longer need rollback snapshots (background)
    if (taskOutcome === "success") {
      void this.cleanupSnapshots(taskId).catch((error) => {
        console.error("[ExperienceRecorder] snapshot cleanup failed:", error);
      });
    }

    // Step 6: Append session summary when task ended usefully and manager is wired
    if (
      (taskOutcome === "success" || taskOutcome === "partial") &&
      this.dependencies.sessionManager
    ) {
      try {
        await Promise.resolve(this.dependencies.sessionManager.append(summary));
      } catch (error) {
        console.error(
          "[ExperienceRecorder] sessionManager.append failed:",
          error,
        );
      }
    }

    // Step 7: Drop from Map so taskId can be reused and memory is freed
    this.activeRecords.delete(taskId);

    // Step 8: Trigger learning asynchronously (extract schedules its own async work)
    try {
      this.dependencies.patternExtractor.extract(record);
    } catch (error) {
      console.error(
        "[ExperienceRecorder] patternExtractor.extract failed:",
        error,
      );
    }
    // Step 9: Return immediately — PatternExtractor and snapshot cleanup are not awaited
  };

  /**
   * @async
   * <Summary>
   * What it does:
   *   Deletes snapshot files under user-data/snapshots/ whose names contain taskId.
   *
   * How it does it (step by step):
   *   1. Read directory listing of snapshotsDir.
   *   2. If directory missing (ENOENT), return without error.
   *   3. Filter filenames that include taskId.
   *   4. Unlink each matching file in parallel (log per-file failures).
   *
   * Parameters:
   *   @param {string} taskId — Task id embedded in snapshot filenames.
   *
   * Returns:
   *   @returns {Promise<void>} — Completes after best-effort deletes.
   *
   * Dependencies:
   *   - fs.readdir, fs.unlink.
   *
   * Dependants:
   *   - ExperienceRecorder.finish — only on success outcome.
   * </Summary>
   */
  private cleanupSnapshots = async (taskId: string): Promise<void> => {
    let snapshotFilenames: string[];
    try {
      // Step 1: List all files in the snapshots directory
      snapshotFilenames = await fs.readdir(this.snapshotsDirectory);
    } catch (error) {
      // Step 2: No snapshots folder yet — nothing to clean (expected on fresh install)
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT") {
        return;
      }
      throw error;
    }

    // Step 3: Only delete files tied to this task (filename contains taskId)
    const matchingFilenames = snapshotFilenames.filter((filename) =>
      filename.includes(taskId),
    );
    // Step 4: Delete in parallel; one failure does not stop others
    await Promise.all(
      matchingFilenames.map((filename) =>
        fs
          .unlink(path.join(this.snapshotsDirectory, filename))
          .catch((unlinkError) => {
            console.error(
              `[ExperienceRecorder] failed to delete snapshot ${filename}:`,
              unlinkError,
            );
          }),
      ),
    );
  };
}
