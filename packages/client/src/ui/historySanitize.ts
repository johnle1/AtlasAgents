const PASSWORD_HISTORY_PATTERN = /^\/set password\s+\S/i;

export const sanitizeHistoryLine = (line: string): string => {
  if (PASSWORD_HISTORY_PATTERN.test(line)) {
    return "/set password ***";
  }
  return line;
};
