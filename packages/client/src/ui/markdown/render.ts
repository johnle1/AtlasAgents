/**
 * Markdown → styled segments for the Ink history view.
 *
 * @remarks
 * `marked` lexes; we walk the token tree ourselves so theming and
 * {@link colorDisabled} stay in our pipeline. Do not use `ink-markdown`
 * (unmaintained, hardcoded colors). Unclosed fences are split off by
 * {@link splitStableMarkdown} and rendered as plain text so a live stream
 * cannot crash or flicker a half-open block.
 *
 * Code fences are marked `code: true` (dim). Shiki highlighting of fences
 * is async and used by diffs; the live stream stays synchronous.
 */

import { marked, type Token, type Tokens } from "marked";

import { colorDisabled } from "../terminalEnv.js";
import { splitStableMarkdown } from "./incremental.js";

/**
 * One styled run of markdown output. Ink maps these onto nested `<Text>`.
 */
export type MarkdownSegment = {
  /** Visible text, including newlines between blocks. */
  text: string;
  /** Heading run (`#` … `######`). */
  heading?: boolean;
  /** Strong / heading emphasis. */
  bold?: boolean;
  /** Dim / code / list chrome. */
  dim?: boolean;
  /** Fenced or inline code. */
  code?: boolean;
};

const lexMarkdown = (source: string): Token[] => {
  try {
    return marked.lexer(source);
  } catch {
    return [{ type: "paragraph", raw: source, text: source, tokens: [] } as Tokens.Paragraph];
  }
};

const push = (
  out: MarkdownSegment[],
  text: string,
  style: Omit<MarkdownSegment, "text"> = {},
): void => {
  if (text.length === 0) return;
  const last = out[out.length - 1];
  if (
    last &&
    Boolean(last.bold) === Boolean(style.bold) &&
    Boolean(last.dim) === Boolean(style.dim) &&
    Boolean(last.heading) === Boolean(style.heading) &&
    Boolean(last.code) === Boolean(style.code)
  ) {
    last.text += text;
    return;
  }
  out.push({ text, ...style });
};

const walkInline = (
  tokens: Token[] | undefined,
  out: MarkdownSegment[],
  style: Omit<MarkdownSegment, "text"> = {},
): void => {
  if (!tokens) return;
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        walkInline(token.tokens, out, { ...style, bold: true });
        break;
      case "em":
        walkInline(token.tokens, out, { ...style, dim: true });
        break;
      case "codespan":
        push(out, token.text, { ...style, code: true, dim: true });
        break;
      case "link":
      case "text":
      case "escape":
        if ("tokens" in token && token.tokens) {
          walkInline(token.tokens, out, style);
        } else if ("text" in token) {
          push(out, token.text, style);
        } else if ("raw" in token) {
          push(out, token.raw, style);
        }
        break;
      default:
        if ("text" in token && typeof token.text === "string") {
          push(out, token.text, style);
        } else if ("raw" in token) {
          push(out, token.raw, style);
        }
    }
  }
};

const walkBlock = (tokens: Token[], out: MarkdownSegment[]): void => {
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        walkInline(token.tokens, out, { heading: true, bold: true });
        push(out, "\n");
        break;
      }
      case "paragraph":
      case "text":
        walkInline(
          "tokens" in token ? token.tokens : undefined,
          out,
        );
        if (token.type === "paragraph") push(out, "\n");
        break;
      case "list": {
        const items = token.items ?? [];
        items.forEach((item: Tokens.ListItem, index: number) => {
          const mark = token.ordered ? `${(token.start ?? 1) + index}. ` : "• ";
          push(out, mark, { dim: true });
          walkInline(item.tokens, out);
          push(out, "\n");
        });
        break;
      }
      case "code":
        push(out, token.text.endsWith("\n") ? token.text : `${token.text}\n`, {
          code: true,
          dim: true,
        });
        break;
      case "blockquote":
        if ("tokens" in token && token.tokens) {
          walkBlock(token.tokens, out);
        }
        break;
      case "space":
        push(out, "\n");
        break;
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) {
          walkBlock(token.tokens, out);
        } else if ("text" in token && typeof token.text === "string") {
          push(out, token.text);
        }
    }
  }
};

/**
 * Lexes markdown and returns styled segments for Ink (or tests).
 *
 * @param source - Raw markdown, possibly a streaming prefix.
 * @returns Segment list. Never throws on incomplete input.
 *
 * @example
 * ```ts
 * renderMarkdownToSegments("say **please**");
 * // [{ text: "say " }, { text: "please", bold: true }]
 * ```
 */
export const renderMarkdownToSegments = (source: string): MarkdownSegment[] => {
  const { stable, tail } = splitStableMarkdown(source);
  const out: MarkdownSegment[] = [];
  if (stable.length > 0) {
    walkBlock(lexMarkdown(stable), out);
  }
  if (tail.length > 0) {
    push(out, tail);
  }
  return out;
};

/**
 * Serializes markdown to a single string, applying SGR only when color is on.
 *
 * @param source - Raw markdown.
 * @returns Plain text under NO_COLOR; otherwise bold/dim CSI around runs.
 */
export const renderMarkdownToAnsi = (source: string): string => {
  const segments = renderMarkdownToSegments(source);
  if (colorDisabled()) {
    return segments.map((segment) => segment.text).join("");
  }
  return segments
    .map((segment) => {
      if (segment.heading || segment.bold) {
        return `\x1b[1m${segment.text}\x1b[0m`;
      }
      if (segment.code || segment.dim) {
        return `\x1b[2m${segment.text}\x1b[0m`;
      }
      return segment.text;
    })
    .join("");
};
