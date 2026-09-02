/**
 * Workspace-context helpers used when building the agent's prompt.
 *
 * @remarks
 * Detects whether the memory context header already includes a workspace
 * structure snapshot, and summarizes it into a short stack hint (language,
 * framework, test runner) so the agent doesn't have to restate a full
 * directory tree. Used by `preparePlanningContext`
 * (`orchestratorPipelineHelpers.ts`), which builds this context ahead of
 * every agent turn.
 */

/**
 * Checks whether the context header includes a workspace structure snapshot.
 *
 * @remarks
 * Used to avoid a redundant workspace snapshot when the context already
 * includes a Structure section from prior exploration or session history.
 *
 * @param contextHeader - Context header text (may include structure section).
 * @returns `true` if context contains a "Structure:" section.
 */
export const contextHasWorkspaceStructure = (contextHeader: string): boolean =>
  /Structure:/i.test(contextHeader);

/**
 * Language/framework detection patterns based on manifest filenames.
 *
 * @remarks
 * Scanned against the workspace structure context to identify the primary stack.
 * Used by `summarizeWorkspaceStackHint` to provide a concise stack label for the agent.
 */
const STACK_MANIFEST_SIGNALS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
}> = [
  {
    pattern:
      /\bpyproject\.toml\b|\brequirements\.txt\b|\bsetup\.py\b|\bPipfile\b/i,
    label: "Python",
  },
  { pattern: /\bgo\.mod\b/i, label: "Go" },
  { pattern: /\bCargo\.toml\b/i, label: "Rust" },
  {
    pattern: /\bpom\.xml\b|\bbuild\.gradle(?:\.kts)?\b/i,
    label: "Java/Kotlin",
  },
  { pattern: /\bGemfile\b/i, label: "Ruby" },
  { pattern: /\bcomposer\.json\b/i, label: "PHP" },
  { pattern: /\bCMakeLists\.txt\b|\bmeson\.build\b/i, label: "C/C++" },
  { pattern: /\bPackage\.swift\b/i, label: "Swift" },
  { pattern: /\bpubspec\.yaml\b/i, label: "Dart/Flutter" },
  { pattern: /\bpackage\.json\b/i, label: "Node.js" },
  { pattern: /\btsconfig\.json\b/i, label: "TypeScript" },
  {
    pattern: /\bnext\.config|\bvite\.config|angular\.json|\.tsx\b/i,
    label: "web UI",
  },
  { pattern: /\bmanage\.py\b/i, label: "Django" },
  { pattern: /\bMakefile\b/i, label: "Make" },
  { pattern: /\bdocker-compose\.ya?ml\b|\bDockerfile\b/i, label: "Docker" },
];

/**
 * Test framework detection patterns based on config filenames and layout.
 *
 * @remarks
 * Complements STACK_MANIFEST_SIGNALS to identify the test runner.
 */
const STACK_TEST_SIGNALS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bvitest\.config/i, label: "Vitest" },
  { pattern: /\bjest\.config/i, label: "Jest" },
  { pattern: /\bmocha\.|\.mocharc/i, label: "Mocha" },
  { pattern: /\bpytest\.ini\b|\bconftest\.py\b/i, label: "pytest" },
  { pattern: /\bnose2\.cfg\b|\bunittest\b/i, label: "Python tests" },
  { pattern: /\b_rspec\b|\.rspec\b|\bspec\/helpers/i, label: "RSpec" },
  { pattern: /_test\.go\b/i, label: "go test" },
  { pattern: /\bcargo\.toml\b/i, label: "cargo test" },
  { pattern: /\bJUnit\b|surefire|gradle.*test/i, label: "JUnit/Gradle test" },
  {
    pattern: /(?:^|\s)(?:tests?|spec|__tests__|_Test_)\//im,
    label: "tests/ layout",
  },
];

/**
 * Extracts matching labels from context text using signal patterns.
 *
 * @remarks
 * Helper for stack hint summarization. Prevents duplicate labels.
 *
 * @param text - Context text to scan.
 * @param signals - Array of pattern/label pairs to test.
 * @returns Array of matched labels (deduplicated).
 */
const collectStackLabels = (
  text: string,
  signals: ReadonlyArray<{ pattern: RegExp; label: string }>,
): string[] => {
  const labels: string[] = [];
  for (const { pattern, label } of signals) {
    if (pattern.test(text) && !labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels;
};

/**
 * Generates a concise stack summary from workspace context for the agent.
 *
 * @remarks
 * When workspace structure is present in context, scans it for language/framework
 * signals and returns a comma-separated label (e.g., "Python + pytest, Docker").
 * Prevents the agent from restating the full directory tree.
 *
 * @param contextHeader - Context header (may include structure snapshot).
 * @returns Stack summary string for the agent (e.g., "Node.js, Jest, web UI"),
 *   or `null` if no structure snapshot present.
 *
 * @example
 * ```ts
 * const hint = summarizeWorkspaceStackHint(contextHeader);
 * Returns "TypeScript, Jest, web UI" or null
 * ```
 */
export const summarizeWorkspaceStackHint = (
  contextHeader: string,
): string | null => {
  if (!contextHasWorkspaceStructure(contextHeader)) {
    return null;
  }

  const stack = [
    ...collectStackLabels(contextHeader, STACK_MANIFEST_SIGNALS),
    ...collectStackLabels(contextHeader, STACK_TEST_SIGNALS),
  ];

  if (stack.length === 0) {
    return "Structure snapshot present — cite stack and test runner briefly; do not list folders.";
  }

  const unique = [...new Set(stack)].slice(0, 5);
  return unique.join(", ");
};
