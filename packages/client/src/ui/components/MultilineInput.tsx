/**
 * Multiline prompt: renders {@link TextBufferState} as Ink
 * rows with a block caret, and routes keystrokes into the pure reducer.
 *
 * @remarks
 * Character input, backspace, horizontal movement, and Enter live here.
 * Newline chords (Ctrl+J / Shift+Enter / Alt+Enter) are owned by
 * {@link createKeyHandler} and reach this component via
 * {@link registerNewlineHandle} so a single owner inserts the break.
 *
 * Large pastes collapse to an atomic `[Pasted text #N]` token; submit
 * expands them back so the agent sees the verbatim clipboard text.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

import {
  bufferToString,
  cursorFromOffset,
  cursorOffset,
  emptyBuffer,
  hasTrailingBackslash,
  stripTrailingBackslash,
  textBufferReducer,
  type TextBufferState,
} from "../multiline/textBuffer.js";
import {
  collapsePaste,
  detectPaste,
  expandPlaceholders,
  placeholderRangeAt,
  PASTE_CHAR_THRESHOLD,
  type PasteMapping,
} from "../multiline/paste.js";
import { registerNewlineHandle } from "../multiline/newlineHandle.js";

export type MultilineInputProps = {
  /** Controlled prompt text (may contain `\n`). */
  value: string;
  /** Called after every reducer update with the serialized buffer. */
  onChange: (next: string) => void;
  /** Called on plain Enter (placeholders already expanded). */
  onSubmit: (line: string) => void;
  /** When true, keys are ignored (parent typically unmounts this). */
  disabled?: boolean;
};

/**
 * Renders a multiline prompt with a reverse-video caret.
 *
 * @param props - Controlled value plus change/submit callbacks.
 */
export const MultilineInput: React.FC<MultilineInputProps> = ({
  value,
  onChange,
  onSubmit,
  disabled = false,
}) => {
  const [buffer, setBuffer] = useState<TextBufferState>(() =>
    textBufferReducer(emptyBuffer(), { type: "setText", text: value }),
  );
  const [pastes, setPastes] = useState<PasteMapping[]>([]);
  const pasteIdRef = useRef(1);
  const lastEmittedRef = useRef(value);

  const emit = useCallback(
    (next: TextBufferState) => {
      const text = bufferToString(next);
      lastEmittedRef.current = text;
      setBuffer(next);
      onChange(text);
    },
    [onChange],
  );

  // Sync from parent when history / autocomplete / Esc rewrite `value`.
  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    setBuffer(
      textBufferReducer(emptyBuffer(), { type: "setText", text: value }),
    );
    if (value.length === 0) {
      setPastes([]);
      pasteIdRef.current = 1;
    }
  }, [value]);

  const insertNewline = useCallback(() => {
    emit(textBufferReducer(buffer, { type: "newline" }));
  }, [buffer, emit]);

  useEffect(() => registerNewlineHandle(insertNewline), [insertNewline]);

  const submitExpanded = useCallback(() => {
    const expanded = expandPlaceholders(bufferToString(buffer), pastes);
    setPastes([]);
    pasteIdRef.current = 1;
    onSubmit(expanded);
  }, [buffer, onSubmit, pastes]);

  useInput(
    (inputCharacter, key) => {
      if (disabled) return;

      // Global handler owns these; do not also insert the character.
      if (key.escape || key.tab || key.ctrl || key.meta) return;
      if (key.return && key.shift) return;

      if (key.return) {
        const text = bufferToString(buffer);
        if (hasTrailingBackslash(text)) {
          const stripped = stripTrailingBackslash(text);
          const next = textBufferReducer(
            textBufferReducer(emptyBuffer(), {
              type: "setText",
              text: stripped,
            }),
            { type: "newline" },
          );
          emit(next);
          return;
        }
        submitExpanded();
        return;
      }

      if (key.backspace) {
        const text = bufferToString(buffer);
        const offset = cursorOffset(buffer);
        const range = placeholderRangeAt(
          text,
          offset,
          pastes.map((paste) => paste.placeholder),
        );
        if (range) {
          const start = cursorFromOffset(buffer, range.start);
          const end = cursorFromOffset(buffer, range.end);
          emit(
            textBufferReducer(buffer, {
              type: "replaceRange",
              start,
              end,
              text: "",
            }),
          );
          setPastes((current) =>
            current.filter((paste) => paste.placeholder !== range.placeholder),
          );
          return;
        }
        emit(textBufferReducer(buffer, { type: "backspace" }));
        return;
      }

      if (key.delete) {
        emit(textBufferReducer(buffer, { type: "delete" }));
        return;
      }

      if (key.leftArrow) {
        emit(
          textBufferReducer(buffer, { type: "moveCursor", direction: "left" }),
        );
        return;
      }
      if (key.rightArrow) {
        emit(
          textBufferReducer(buffer, { type: "moveCursor", direction: "right" }),
        );
        return;
      }

      const multiline = buffer.lines.length > 1;
      if (multiline && key.upArrow) {
        emit(
          textBufferReducer(buffer, { type: "moveCursor", direction: "up" }),
        );
        return;
      }
      if (multiline && key.downArrow) {
        emit(
          textBufferReducer(buffer, { type: "moveCursor", direction: "down" }),
        );
        return;
      }

      if (key.upArrow || key.downArrow) return;

      if (inputCharacter === "\x01") {
        emit(textBufferReducer(buffer, { type: "home" }));
        return;
      }
      if (inputCharacter === "\x05") {
        emit(textBufferReducer(buffer, { type: "end" }));
        return;
      }

      if (inputCharacter.length === 0) return;

      const previous = bufferToString(buffer);
      let inserted = inputCharacter;
      if (detectPaste(previous, `${previous}${inputCharacter}`)) {
        const collapsed = collapsePaste(
          inputCharacter,
          PASTE_CHAR_THRESHOLD,
          pasteIdRef.current,
        );
        if (collapsed.placeholder !== collapsed.fullText) {
          pasteIdRef.current += 1;
          setPastes((current) => [
            ...current,
            {
              placeholder: collapsed.placeholder,
              fullText: collapsed.fullText,
            },
          ]);
          inserted = collapsed.display;
        }
      }
      emit(textBufferReducer(buffer, { type: "insertText", text: inserted }));
    },
    { isActive: !disabled },
  );

  const { lines, cursor } = buffer;

  return (
    <Box flexDirection="column">
      {lines.map((line, row) => {
        const isCursorRow = row === cursor.row;
        if (!isCursorRow) {
          return <Text key={row}>{line.length === 0 ? " " : line}</Text>;
        }
        const col = Math.min(cursor.col, line.length);
        const before = line.slice(0, col);
        const at = line.slice(col, col + 1);
        const after = line.slice(col + 1);
        return (
          <Text key={row}>
            {before}
            <Text inverse>{at.length > 0 ? at : " "}</Text>
            {after}
          </Text>
        );
      })}
    </Box>
  );
};
