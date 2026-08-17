/**
 * Lazy Shiki (`@shikijs/cli`) wrapper for single-line ANSI syntax highlighting.
 *
 * @remarks
 * Diff rendering highlights each line independently. The CLI package is loaded
 * once via dynamic `import` and cached so the first highlight pays the load
 * cost; {@link initShiki} can warm grammars at startup to avoid a hitch on the
 * first file write preview.
 */

/**
 * Shiki `codeToANSI` signature used by this module.
 *
 * @param code - Source text to colorize.
 * @param lang - Shiki language id (from {@link detectLang}).
 * @param theme - Shiki theme name (from the active AtlasAgents UI theme).
 * @returns Promise of an ANSI-colored string (often with a trailing newline).
 */
type CodeToANSI = (
  code: string,
  lang: string,
  theme: string,
) => Promise<string>;

/** Cached `codeToANSI` after the first successful dynamic import; `null` until loaded. */
let codeToANSIImpl: CodeToANSI | null = null;

/**
 * Returns the Shiki `codeToANSI` function, loading `@shikijs/cli` on first use.
 *
 * @returns Cached highlighter function.
 */
const getCodeToANSI = async (): Promise<CodeToANSI> => {
  if (codeToANSIImpl === null) {
    // Dynamic import keeps Shiki out of the cold startup graph until a diff needs it.
    const shikiModule = await import("@shikijs/cli");
    codeToANSIImpl = shikiModule.codeToANSI as CodeToANSI;
  }

  return codeToANSIImpl;
};

/**
 * Warms the Shiki module, grammars, and a theme with a one-line probe.
 *
 * @remarks
 * Call during CLI bootstrap if you want the first `highlightLine` to be cheap.
 * The sample language/theme only matter for force-loading dependencies.
 *
 * @returns Resolves when the warm-up highlight finishes.
 *
 * @example
 * ```ts
 * await initShiki();
 * // later:
 * const line = await highlightLine("const x = 1", "typescript", "dark-plus");
 * ```
 */
export const initShiki = async (): Promise<void> => {
  const codeToANSI = await getCodeToANSI();
  await codeToANSI("const x = 1", "typescript", "dark-plus");
};

/**
 * Highlights one source line to ANSI, stripping Shiki’s trailing newlines.
 *
 * @remarks
 * Diff rows are joined with `"\n"`; Shiki often appends its own newline per
 * call, which would create blank gaps if left in place. On highlighter failure
 * (unsupported lang, theme error), returns plain `trimEnd`’d code so the diff
 * still renders.
 *
 * @param code - Single line of source (may have trailing whitespace).
 * @param lang - Shiki language id.
 * @param shikiTheme - Shiki theme name from `getTheme().shikiTheme`.
 * @returns ANSI string without trailing `\n`, or uncolored fallback text.
 *
 * @example
 * ```ts
 * const ansi = await highlightLine(
 *   "export const n = 1;",
 *   "typescript",
 *   "dark-plus",
 * );
 * ```
 */
export const highlightLine = async (
  code: string,
  lang: string,
  shikiTheme: string,
): Promise<string> => {
  const trimmedCode = code.trimEnd();

  try {
    const codeToANSI = await getCodeToANSI();
    const highlightedCode = await codeToANSI(trimmedCode, lang, shikiTheme);
    // Shiki appends a newline; our join("\n") would otherwise double-space rows.
    return highlightedCode.replace(/\n+$/g, "");
  } catch {
    return trimmedCode;
  }
};
