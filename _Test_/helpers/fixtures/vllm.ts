/**
 * Fixture generators for vLLM `/v1/chat/completions` responses.
 *
 * Covers:
 * 1. Standard token streaming
 * 2. Fragmented tool calling (chunked function name + arguments)
 * 3. Reasoning tokens (`reasoning_content`)
 * 4. Usage object chunk at end of stream
 */

/** Creates vLLM SSE frames for streamed text */
export const createVllmTextSseFrames = (
  tokens: string[],
  options?: {
    model?: string;
    includeUsage?: boolean;
  },
): string[] => {
  const model = options?.model ?? "meta-llama/Llama-3.1-8B-Instruct";
  const frames: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    frames.push(
      JSON.stringify({
        id: "cmpl-vllm-789",
        object: "chat.completion.chunk",
        created: 1700000000 + i,
        model,
        choices: [
          {
            index: 0,
            delta: { content: tokens[i] },
            finish_reason: null,
          },
        ],
      }),
    );
  }

  // Final stop frame
  const finalChoice: Record<string, unknown> = {
    index: 0,
    delta: {},
    finish_reason: "stop",
  };

  const finalPayload: Record<string, unknown> = {
    id: "cmpl-vllm-789",
    object: "chat.completion.chunk",
    created: 1700000000 + tokens.length,
    model,
    choices: [finalChoice],
  };

  if (options?.includeUsage) {
    finalPayload.usage = {
      prompt_tokens: 24,
      completion_tokens: tokens.length,
      total_tokens: 24 + tokens.length,
    };
  }

  frames.push(JSON.stringify(finalPayload));
  return frames;
};

/** Creates vLLM SSE frames for streamed tool calls fragmented across chunks */
export const createVllmToolCallSseFrames = (
  toolCalls: Array<{
    name: string;
    argChunks: string[];
    id?: string;
  }>,
  model = "meta-llama/Llama-3.1-8B-Instruct",
): string[] => {
  const frames: string[] = [];

  toolCalls.forEach((tc, toolIndex) => {
    const toolCallId = tc.id ?? `call_${toolIndex}_vllm`;

    // First frame provides the name and ID
    frames.push(
      JSON.stringify({
        id: "cmpl-vllm-tool-123",
        object: "chat.completion.chunk",
        created: 1700000000,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: toolIndex,
                  id: toolCallId,
                  type: "function",
                  function: { name: tc.name, arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );

    // Subsequent frames provide fragments of arguments
    for (const argChunk of tc.argChunks) {
      frames.push(
        JSON.stringify({
          id: "cmpl-vllm-tool-123",
          object: "chat.completion.chunk",
          created: 1700000000,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    function: { arguments: argChunk },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
    }
  });

  // Finish frame
  frames.push(
    JSON.stringify({
      id: "cmpl-vllm-tool-123",
      object: "chat.completion.chunk",
      created: 1700000000,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
    }),
  );

  return frames;
};

/** Creates vLLM SSE frames with reasoning content deltas */
export const createVllmReasoningSseFrames = (
  thinkingTokens: string[],
  contentTokens: string[],
  model = "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B",
): string[] => {
  const frames: string[] = [];

  for (const token of thinkingTokens) {
    frames.push(
      JSON.stringify({
        id: "cmpl-vllm-reason-123",
        object: "chat.completion.chunk",
        created: 1700000000,
        model,
        choices: [
          {
            index: 0,
            delta: { reasoning_content: token },
            finish_reason: null,
          },
        ],
      }),
    );
  }

  for (const token of contentTokens) {
    frames.push(
      JSON.stringify({
        id: "cmpl-vllm-reason-123",
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

  frames.push(
    JSON.stringify({
      id: "cmpl-vllm-reason-123",
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
