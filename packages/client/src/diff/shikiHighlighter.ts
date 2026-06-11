/**
 * <Summary>
 * What it does:
 *   Defines the function signature for Shiki's code-to-ANSI highlighting function.
 *
 * Used by:
 *   - getCodeToANSI — casts the imported module function to this type.
 *   - highlightLine — calls this function to perform actual highlighting.
 *
 * Produced by:
 *   - None (type definition defined at module level).
 * </Summary>
 */
type CodeToANSI = (
  code: string,
  lang: string,
  theme: string,
) => Promise<string>;

/**
 * <Summary>
 * What it does:
 *   Caches the loaded Shiki codeToANSI implementation to avoid repeated imports.
 *
 * Used by:
 *   - getCodeToANSI — stores and retrieves the cached implementation.
 *
 * Produced by:
 *   - getCodeToANSI — sets this value on first import.
 * </Summary>
 */
let codeToANSIImpl: CodeToANSI | null = null;

/**
 * <Summary>
 * What it does:
 *   Lazily loads and returns the Shiki codeToANSI function, caching it after first load.
 *
 * How it does it (step by step):
 *   1. Check if the implementation has already been loaded and cached.
 *   2. If not cached, dynamically import the @shikijs/cli module.
 *   3. Extract the codeToANSI function from the imported module.
 *   4. Cache the implementation for future calls.
 *   5. Return the cached implementation.
 *
 * Returns:
 *   @returns {Promise<CodeToANSI>} — The Shiki codeToANSI function that converts code to ANSI-colored strings.
 *
 * Dependencies:
 *   - @shikijs/cli — external module providing the syntax highlighting functionality.
 *
 * Dependants:
 *   - initShiki — calls this to get the function for initialization.
 *   - highlightLine — calls this to get the function for actual highlighting.
 * </Summary>
 */
const getCodeToANSI = async (): Promise<CodeToANSI> => {
  // ===== STEP 1: Check if implementation is already cached =====
  // Step 1a: If the implementation is null, it hasn't been loaded yet
  if (codeToANSIImpl === null) {
    // ===== STEP 2: Dynamically import Shiki module =====
    // Step 2a: Import the @shikijs/cli module (dynamic import for lazy loading)
    const shikiModule = await import("@shikijs/cli");

    // ===== STEP 3: Extract and cache the implementation =====
    // Step 3a: Cast the imported codeToANSI function to our type and cache it
    codeToANSIImpl = shikiModule.codeToANSI as CodeToANSI;
  }

  // ===== STEP 4: Return the cached implementation =====
  // Step 4a: Return the cached function (either just loaded or from previous call)
  return codeToANSIImpl;
};

/**
 * <Summary>
 * What it does:
 *   Initializes the Shiki syntax highlighter by triggering a one-time warm-up call.
 *
 * How it does it (step by step):
 *   1. Get the codeToANSI function (which triggers module loading if needed).
 *   2. Call the function with sample code to force Shiki to load grammars and themes.
 *   3. This ensures subsequent highlighting calls are fast and ready.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when Shiki is fully initialized.
 *
 * Dependencies:
 *   - getCodeToANSI — provides the highlighting function.
 *   - @shikijs/cli — loads syntax grammars and themes during the warm-up call.
 *
 * Dependants:
 *   - Application startup code — calls this once during initialization.
 * </Summary>
 */
export const initShiki = async (): Promise<void> => {
  // ===== STEP 1: Get the highlighting function =====
  // Step 1a: Retrieve the codeToANSI function (loads module if first call)
  const codeToANSI = await getCodeToANSI();

  // ===== STEP 2: Warm up Shiki with sample code =====
  // Step 2a: Call Shiki with sample TypeScript code to trigger grammar/theme loading
  // The specific code, language, and theme don't matter - this just forces initialization
  await codeToANSI("const x = 1", "typescript", "dark-plus");
};

/**
 * <Summary>
 * What it does:
 *   Highlights a single line of code using Shiki and returns the ANSI-colored result.
 *
 * How it does it (step by step):
 *   1. Remove trailing whitespace from the input code.
 *   2. Get the codeToANSI function from Shiki.
 *   3. Call Shiki to highlight the code with the specified language and theme.
 *   4. Remove trailing newlines added by Shiki (prevents double-spacing in diff output).
 *   5. If highlighting fails, fall back to returning the plain trimmed code.
 *
 * Parameters:
 *   @param {string} code — The line of code to highlight (e.g., "function foo() { return 42; }").
 *   @param {string} lang — The language identifier (e.g., "typescript", "javascript", "python").
 *   @param {string} shikiTheme — The Shiki theme name (e.g., "dark-plus", "github-dark").
 *
 * Returns:
 *   @returns {Promise<string>} — ANSI-colored string with syntax highlighting, or plain code if highlighting fails.
 *
 * Dependencies:
 *   - getCodeToANSI — provides the Shiki highlighting function.
 *   - @shikijs/cli — performs the actual syntax highlighting.
 *
 * Dependants:
 *   - diffRenderer — calls this for each line in the diff to add syntax highlighting.
 * </Summary>
 */
export const highlightLine = async (
  code: string,
  lang: string,
  shikiTheme: string,
): Promise<string> => {
  // ===== STEP 1: Clean the input code =====
  // Step 1a: Remove trailing whitespace from the code line
  const trimmedCode = code.trimEnd();

  try {
    // ===== STEP 2: Get the highlighting function =====
    // Step 2a: Retrieve the codeToANSI function (already cached after initShiki call)
    const codeToANSI = await getCodeToANSI();

    // ===== STEP 3: Perform syntax highlighting =====
    // Step 3a: Call Shiki to convert the code to ANSI-colored text
    const highlightedCode = await codeToANSI(trimmedCode, lang, shikiTheme);

    // ===== STEP 4: Handle Shiki's trailing newline behavior =====
    // Step 4a: Shiki appends a newline to each highlighted line
    // Step 4b: Since diff rows are joined with "\n", we need to remove trailing newlines
    // Step 4c: This prevents double-spacing in the diff output
    const cleanedHighlight = highlightedCode.replace(/\n+$/g, "");

    // ===== STEP 5: Return the cleaned highlighted code =====
    return cleanedHighlight;
  } catch {
    // ===== STEP 6: Fallback on error =====
    // Step 6a: If Shiki fails to highlight, return the plain trimmed code
    // This ensures the diff still renders even if syntax highlighting breaks
    return trimmedCode;
  }
};
