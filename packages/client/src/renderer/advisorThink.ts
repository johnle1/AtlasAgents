/** Display-only: remove UNDERSTAND section from advisor think (planning unchanged on server). */
export const formatAdvisorThinkForDisplay = (thinkText: string): string => {
  const stripped = thinkText
    .replace(/^\s*UNDERSTAND:\s*[\s\S]*?(?=\n\s*CONTEXT FROM SESSION:)/im, "")
    .trim();
  return stripped.length > 0 ? stripped : "Planning...";
};
