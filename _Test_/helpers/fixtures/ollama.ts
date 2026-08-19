/**
 * Fixture generators for Ollama responses.
 *
 * Covers both:
 * 1. Ollama native NDJSON `/api/chat` stream protocol
 * 2. Ollama OpenAI-compatible `/v1/chat/completions` SSE stream protocol
 */

/** Creates Ollama native NDJSON stream chunks for a text response */
export const createOllamaNativeTextChunks = (tokens: string[], model = "llama3.1"): string[] => {
  const chunks = tokens.map((token) =>
    JSON.stringify({
      model,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: token },
      done: false,
    }) + "\n",
  );

  chunks.push(
    JSON.stringify({
      model,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      total_duration: 123456789,
      load_duration: 123456,
      prompt_eval_count: 10,
      eval_count: tokens.length,
    }) + "\n",
  );

  return chunks;
};

/** Creates Ollama native NDJSON stream chunks for tool calls */
export const createOllamaNativeToolChunks = (
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  model = "llama3.1",
): string[] => {
  const chunks = [
    JSON.stringify({
      model,
      created_at: new Date().toISOString(),
      message: {
        role: "assistant",
        content: "",
        tool_calls: toolCalls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: tc.args,
          },
        })),
      },
      done: false,
    }) + "\n",
    JSON.stringify({
      model,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
    }) + "\n",
  ];

  return chunks;
};

/** Creates Ollama OpenAI-compatible `/v1/chat/completions` SSE frames */
export const createOllamaOpenAiSseFrames = (
  tokens: string[],
  options?: { finishReason?: string | null },
): string[] => {
  const frames: string[] = [];

  for (const token of tokens) {
    frames.push(
      JSON.stringify({
        id: "chatcmpl-ollama-123",
        object: "chat.completion.chunk",
        created: 1700000000,
        model: "llama3.1",
        choices: [
          {
            index: 0,
            delta: { content: token },
            finish_reason: null,
          },
        ],
      }),
    );
  }

  frames.push(
    JSON.stringify({
      id: "chatcmpl-ollama-123",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "llama3.1",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: options?.finishReason !== undefined ? options.finishReason : "stop",
        },
      ],
    }),
  );

  return frames;
};
