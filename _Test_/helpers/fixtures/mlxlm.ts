/**
 * Fixture generators for MLX-LM (`mlx_lm.server`) responses.
 *
 * Covers:
 * 1. Minimal OpenAI-compatible SSE streaming (Apple Silicon local runner)
 * 2. Unassisted tool behavior (silently ignores tools and streams plain text)
 * 3. Minimal choices/delta shapes without extra metadata
 */

/** Creates MLX-LM SSE frames for streamed text */
export const createMlxlmTextSseFrames = (
  tokens: string[],
  model = "mlx-community/Llama-3.2-3B-Instruct-4bit",
): string[] => {
  const frames: string[] = [];

  for (const token of tokens) {
    frames.push(
      JSON.stringify({
        id: "chatcmpl-mlx-001",
        object: "chat.completion.chunk",
        created: 1700000000,
        model,
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

  // MLX-LM stop chunk
  frames.push(
    JSON.stringify({
      id: "chatcmpl-mlx-001",
      object: "chat.completion.chunk",
      created: 1700000000,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    }),
  );

  return frames;
};

/**
 * Creates MLX-LM SSE frames when tools were supplied in the request but
 * the backend lacks native tool support, returning text instead.
 */
export const createMlxlmToolFallbackSseFrames = (
  textOutput: string,
  model = "mlx-community/Llama-3.2-3B-Instruct-4bit",
): string[] => {
  return [
    JSON.stringify({
      id: "chatcmpl-mlx-tools-fallback",
      object: "chat.completion.chunk",
      created: 1700000000,
      model,
      choices: [
        {
          index: 0,
          delta: { content: textOutput },
          finish_reason: null,
        },
      ],
    }),
    JSON.stringify({
      id: "chatcmpl-mlx-tools-fallback",
      object: "chat.completion.chunk",
      created: 1700000000,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    }),
  ];
};
