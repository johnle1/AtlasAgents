/**
 * <Summary>
 * What it does:
 *   Maps file extensions to their corresponding programming language identifiers
 *   for syntax highlighting and language detection.
 *
 * Used by:
 *   - detectLang — looks up language names by file extension.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
const EXTENSION_TO_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "mdx",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".svg": "xml",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "fish",
  ".dockerfile": "dockerfile",
  ".vue": "vue",
  ".svelte": "svelte",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".lua": "lua",
  ".r": "r",
  ".zig": "zig",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".tf": "hcl",
  ".proto": "protobuf",
  ".ini": "ini",
  ".env": "dotenv",
};

/**
 * <Summary>
 * What it does:
 *   Detects the programming language of a file based on its path and extension.
 *
 * How it does it (step by step):
 *   1. Extract the filename from the full file path by splitting on path separators.
 *   2. Convert the filename to lowercase for case-insensitive comparison.
 *   3. Check if the file is a Dockerfile (either named "dockerfile" or starts with "dockerfile.").
 *   4. Check if the file is a TypeScript declaration file (ends with ".d.ts").
 *   5. Extract the file extension from the filename and look it up in the extension map.
 *   6. If no match is found, default to "text" as a fallback language.
 *
 * Parameters:
 *   @param filePath - Full file path including directory and filename (e.g., "/src/components/Button.tsx").
 *
 * Returns:
 *   @returns Language identifier string (e.g., "typescript", "javascript", "text").
 * </Summary>
 */
export const detectLang = (filePath: string): string => {
  // ===== STEP 1: Extract filename from path =====
  // Step 1a: Split the file path by forward slashes or backslashes (handles both Unix and Windows paths)
  // Step 1b: Pop the last element which is the filename, or use the full path if split fails
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;

  // ===== STEP 2: Convert filename to lowercase =====
  // Step 2a: Convert the filename to lowercase for case-insensitive comparison
  // Example: "Button.TSX" becomes "button.tsx"
  const lowerCaseFileName = fileName.toLowerCase();

  // ===== STEP 3: Check for Dockerfile =====
  // Step 3a: Check if the file is exactly named "dockerfile" or starts with "dockerfile."
  // Example: "Dockerfile", "dockerfile.dev", "Dockerfile.production" all return "dockerfile"
  if (
    lowerCaseFileName === "dockerfile" ||
    lowerCaseFileName.startsWith("dockerfile.")
  ) {
    return "dockerfile";
  }

  // ===== STEP 4: Check for TypeScript declaration files =====
  // Step 4a: Check if the file ends with ".d.ts" (TypeScript declaration file extension)
  // Example: "index.d.ts", "component.d.ts" both return "typescript"
  if (lowerCaseFileName.endsWith(".d.ts")) {
    return "typescript";
  }

  // ===== STEP 5: Extract and lookup file extension =====
  // Step 5a: Find the last occurrence of a dot in the filename (extension separator)
  const lastDotIndex = lowerCaseFileName.lastIndexOf(".");

  // Step 5b: If a dot was found, extract the extension including the dot
  if (lastDotIndex >= 0) {
    const fileExtension = lowerCaseFileName.slice(lastDotIndex);

    // Step 5c: Look up the extension in the extension-to-language map
    const detectedLanguage = EXTENSION_TO_LANGUAGE_MAP[fileExtension];

    // Step 5d: If the extension exists in the map, return the corresponding language
    if (detectedLanguage) {
      return detectedLanguage;
    }
  }

  // ===== STEP 6: Default fallback =====
  // Step 6a: If no language was detected, return "text" as a safe fallback
  // This ensures all files have some language identifier for rendering
  return "text";
};
