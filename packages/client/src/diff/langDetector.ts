/**
 * Maps filesystem paths to Shiki language ids for diff syntax highlighting.
 *
 * @remarks
 * Used by {@link renderDiffFromChunks} / {@link renderDiff} via
 * {@link detectLang}. Unknown extensions fall back to `"text"` so highlighting
 * still runs without throwing.
 */

/**
 * Extension → Shiki language id table (lowercase keys including the leading `.`).
 *
 * @remarks
 * Not every extension Shiki supports is listed — only common ones for agent
 * workspaces. Special cases (Dockerfile, `.d.ts`) are handled in
 * {@link detectLang} before this map is consulted.
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
 * Infers a Shiki language id from a file path.
 *
 * @remarks
 * Checks, in order:
 * 1. Basename `Dockerfile` / `dockerfile.*` → `"dockerfile"` (no extension)
 * 2. `*.d.ts` → `"typescript"` (would otherwise look like `.ts` only partially)
 * 3. Last `.ext` in {@link EXTENSION_TO_LANGUAGE_MAP}
 * 4. Fallback `"text"`
 *
 * Matching is case-insensitive on the basename. Windows and POSIX separators
 * are both accepted when extracting the filename.
 *
 * @param filePath - Absolute or relative path, e.g. `src/Button.tsx`.
 * @returns Shiki language string such as `"typescript"`, `"bash"`, or `"text"`.
 *
 * @example
 * ```ts
 * detectLang("packages/client/src/app.tsx"); // "tsx"
 * detectLang("Dockerfile.prod");             // "dockerfile"
 * detectLang("types/index.d.ts");            // "typescript"
 * detectLang("notes.txt");                   // "text"
 * ```
 */
export const detectLang = (filePath: string): string => {
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
  const lowerCaseFileName = fileName.toLowerCase();

  // Dockerfiles often have no extension; variants like Dockerfile.dev still count.
  if (
    lowerCaseFileName === "dockerfile" ||
    lowerCaseFileName.startsWith("dockerfile.")
  ) {
    return "dockerfile";
  }

  // `.d.ts` ends with `.ts` but is declaration syntax — treat as TypeScript explicitly.
  if (lowerCaseFileName.endsWith(".d.ts")) {
    return "typescript";
  }

  const lastDotIndex = lowerCaseFileName.lastIndexOf(".");
  if (lastDotIndex >= 0) {
    const fileExtension = lowerCaseFileName.slice(lastDotIndex);
    const detectedLanguage = EXTENSION_TO_LANGUAGE_MAP[fileExtension];
    if (detectedLanguage) {
      return detectedLanguage;
    }
  }

  return "text";
};
