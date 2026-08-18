/**
 * Ink view for a markdown source string (assistant text / live stream).
 *
 * @remarks
 * Stores raw markdown in history; this component renders at view time so
 * Alt+M can flip committed rows to the source without rewriting state.
 */

import React from "react";
import { Text } from "ink";

import { renderMarkdownToSegments } from "../markdown/render.js";

export type MarkdownViewProps = {
  /** Raw markdown (or plain text when `raw` is true). */
  source: string;
  /** When true, skip lexing and show the source verbatim. */
  raw?: boolean;
  /** Optional Ink color for the whole block (assistant stays default). */
  color?: string;
};

/**
 * Renders markdown as nested Ink `<Text>` runs.
 *
 * @param props - Source plus raw/color flags.
 */
export const MarkdownView: React.FC<MarkdownViewProps> = ({
  source,
  raw = false,
  color,
}) => {
  if (raw) {
    return <Text color={color}>{source}</Text>;
  }
  const segments = renderMarkdownToSegments(source);
  return (
    <Text color={color}>
      {segments.map((segment, index) => (
        <Text
          key={index}
          bold={segment.bold || segment.heading}
          dimColor={segment.dim || segment.code}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
};
