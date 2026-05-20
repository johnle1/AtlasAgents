/**
 * <Summary>
 * What it does:
 *   Executes one subtask with streaming Ollama output, optional ESCALATE
 *   hand-off to Advisor.advise, and bounded retry via config max attempts.
 *
 * How it fits in the system:
 *   Instantiated per subtask wave by AdvisorOrchestrator; stateless between runs.
 *
 * Dependencies:
 *   - IOllamaClient — chatStream for execution.
 *   - IConfigManager — agent model, temperature, max attempts.
 *   - Advisor — advise on escalation.
 *
 * Dependants:
 *   - AdvisorOrchestrator — parallel or sequential subtask execution.
 * </Summary>
 */

import type { Advisor } from "./advisor.js";
import type { IConfigManager, IOllamaClient } from "./interfaces.js";
import type { Message } from "./types.js";

const ESCALATE_INSTRUCTION = `\n\nIf you are blocked, lack critical information, or cannot proceed safely, respond with a single assistant message whose text begins with exactly this prefix on the first line:\nESCALATE: <short reason>\nOtherwise complete the subtask normally without using that prefix.`;

/**
 * <Summary>
 * What it does:
 *   Detects whether the full model output is an escalation and extracts the reason text.
 *
 * Parameters:
 *   @param {string} full — Concatenated streamed assistant response.
 *
 * Returns:
 *   @returns {{ escalate: true; reason: string } | { escalate: false }} — Parsed escalation state.
 *
 * Dependencies:
 *   None.
 *
 * Dependants:
 *   - Agent.run — branch after each stream completes.
 * </Summary>
 */
const parseEscalation = (
    full: string,
): { escalate: true; reason: string } | { escalate: false } => {
    const t = full.trimStart();
    const lower = t.slice(0, 12).toLowerCase();
    if (!lower.startsWith("escalate:")) {
        return { escalate: false };
    }
    const colon = t.indexOf(":");
    const reason = colon === -1 ? "" : t.slice(colon + 1).trim();
    return {
        escalate: true,
        reason: reason.length > 0 ? reason : "unspecified",
    };
};

export class Agent {
    /**
     * @param {{ ollama: IOllamaClient; config: IConfigManager; advisor: Advisor }} deps — Model IO, settings, and advisor for escalation.
     */
    constructor(
        private readonly deps: {
            ollama: IOllamaClient;
            config: IConfigManager;
            advisor: Advisor;
        },
    ) { }

    /**
     * @async
     * <Summary>
     * What it does:
     *   Runs one subtask with streaming tokens, advisor retries on ESCALATE, and a hard attempt cap.
     *
     * How it does it (step by step):
     *   1. Reads agent model, temperature, and max retry count from config (at least one attempt).
     *   2. Builds system prompt from skill content, session context, and escalation instruction.
     *   3. Loops: streams Ollama tokens to emit; if output is not ESCALATE returns full text.
     *   4. On ESCALATE: if attempts exhausted returns a failure summary string; else calls Advisor.advise, appends assistant and user turns, repeats.
     *
     * Parameters:
     *   @param {string} subtask — Concrete instruction for this worker step.
     *   @param {string} skillContent — Selected skill body (may be empty).
     *   @param {string} sessionContext — Prior subtask results text block (may be empty).
     *   @param {(token: string) => void} emit — Per-token sink (orchestrator may no-op for user stream).
     *   @param {AbortSignal} signal — Aborts streaming or between attempts.
     *
     * Returns:
     *   @returns {Promise<string>} — Final subtask result or bracketed failure summary.
     *
     * @throws {Error} — When signal is aborted (message "Aborted").
     *
     * Dependencies:
     *   - IConfigManager.getAgentModel, getAgentTemperature, getMaxRetries.
     *   - IOllamaClient.chatStream.
     *   - Advisor.advise.
     *   - parseEscalation.
     *
     * Dependants:
     *   - AdvisorOrchestrator — one Agent per subtask in a wave.
     * </Summary>
     */
    run = async (
        subtask: string,
        skillContent: string,
        sessionContext: string,
        emit: (token: string) => void,
        signal: AbortSignal,
    ): Promise<string> => {
        // --- Load runtime settings (who runs, how hot, how many Ollama streams allowed) ---
        const model = await this.deps.config.getAgentModel();
        const temperature = await this.deps.config.getAgentTemperature();
        const configured = await this.deps.config.getMaxRetries();
        // At least one chatStream call; floor guards non-integer config values.
        const maxAttempts = Math.max(1, Math.floor(configured));

        // --- Build system prompt: skill + prior subtask context, then ESCALATE rules ---
        // Order matches architecture: skill body first, then "what already happened" from deps.
        const systemCore = [skillContent.trim(), sessionContext.trim()]
            .filter((s) => s.length > 0)
            .join("\n\n");
        const system =
            systemCore.length > 0
                ? `${systemCore}${ESCALATE_INSTRUCTION}`
                : `You are a capable coding agent.${ESCALATE_INSTRUCTION}`;

        // Initial transcript: one system contract + the concrete subtask as first user turn.
        const messages: Message[] = [
            { role: "system", content: system },
            { role: "user", content: subtask },
        ];

        // Counts completed Ollama streams (each stream = one "attempt" toward maxAttempts).
        let streamAttempts = 0;

        // Loop: each iteration is one full chatStream read until ESCALATE or success.
        while (streamAttempts < maxAttempts) {
            // Cooperative cancel — checked before starting a new stream and inside the stream loop.
            if (signal.aborted) {
                throw new Error("Aborted");
            }
            streamAttempts += 1;
            let full = "";
            // Accumulate every token from this generation (used for return value or ESCALATE parse).
            for await (const token of this.deps.ollama.chatStream(model, messages, {
                temperature,
            })) {
                if (signal.aborted) {
                    throw new Error("Aborted");
                }
                emit(token);
                full += token;
            }

            // After stream ends: decide normal completion vs escalation protocol.
            const esc = parseEscalation(full);
            if (!esc.escalate) {
                // Normal path — full assistant text is the subtask result for the orchestrator.
                return full;
            }

            // Escalation on the last allowed stream: do not call advisor again; surface failure text.
            if (streamAttempts >= maxAttempts) {
                return `[agent failed after ${maxAttempts} attempts: ${esc.reason}]`;
            }

            // Blocking advisor call — agent waits; history is the exact messages Ollama saw so far.
            const guidance = await this.deps.advisor.advise(
                subtask,
                esc.reason,
                messages,
            );
            // Record what the model just said (the ESCALATE response) as assistant turn.
            messages.push({ role: "assistant", content: full });
            // Inject advisor hint as a new user instruction; next loop sends expanded history to Ollama.
            messages.push({
                role: "user",
                content: `Follow this guidance and continue the subtask:\n${guidance}`,
            });
        }

        // Defensive fallback — loop normally returns or throws before here.
        return `[agent failed after ${maxAttempts} attempts: exhausted retry budget]`;
    };
}
