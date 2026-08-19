/**
 * Fixtures for network and SSE protocol edge cases.
 *
 * Simulates TCP packet fragmentation, missing terminal markers,
 * interleaved malformed lines, and empty delta chunks.
 */

/**
 * Encodes SSE frames into a ReadableStream where chunks are deliberately
 * fragmented across arbitrary byte boundaries (simulating TCP segmentation).
 */
export const createSplitTcpSseStream = (
  frames: string[],
  splitSize = 10,
  includeDone = true,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let fullPayload = frames.map((f) => `data: ${f}\n\n`).join("");
  if (includeDone) {
    fullPayload += "data: [DONE]\n\n";
  }

  const rawBytes = encoder.encode(fullPayload);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < rawBytes.length; offset += splitSize) {
        const slice = rawBytes.subarray(offset, Math.min(offset + splitSize, rawBytes.length));
        controller.enqueue(slice);
      }
      controller.close();
    },
  });
};

/**
 * Creates an SSE stream that terminates cleanly at TCP level without
 * ever sending the `data: [DONE]` marker.
 */
export const createMissingDoneSseStream = (frames: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const fullPayload = frames.map((f) => `data: ${f}\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(fullPayload));
      controller.close();
    },
  });
};

/**
 * Creates an SSE body with empty deltas, comments (`: ping`), whitespace, and valid frames.
 */
export const createNoisySseFrames = (validTokens: string[]): string[] => {
  const frames: string[] = [];

  // Empty delta before content
  frames.push(
    JSON.stringify({
      choices: [{ delta: {} }],
    }),
  );

  for (const token of validTokens) {
    frames.push(
      JSON.stringify({
        choices: [{ delta: { content: token } }],
      }),
    );
    // Interspersed empty content delta
    frames.push(
      JSON.stringify({
        choices: [{ delta: { content: "" } }],
      }),
    );
  }

  return frames;
};

/**
 * Creates NDJSON chunks split across packet boundaries.
 */
export const createSplitNdjsonStream = (
  lines: string[],
  splitSize = 8,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const fullPayload = lines.join("");
  const rawBytes = encoder.encode(fullPayload);

  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < rawBytes.length; offset += splitSize) {
        const slice = rawBytes.subarray(offset, Math.min(offset + splitSize, rawBytes.length));
        controller.enqueue(slice);
      }
      controller.close();
    },
  });
};
