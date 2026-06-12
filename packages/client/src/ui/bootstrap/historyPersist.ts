import * as fs from "node:fs";
import { HISTORY_FILE, ensureDirs } from "../../config.js";
import { sanitizeHistoryLine } from "../historySanitize.js";

const MAX_HISTORY = 1_000;

export const loadHistory = (): string[] => {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
    return raw.split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

export const saveHistory = (lines: string[]): void => {
  ensureDirs();
  const trimmed = lines
    .slice(-MAX_HISTORY)
    .map((line) => sanitizeHistoryLine(line));
  fs.writeFileSync(HISTORY_FILE, trimmed.join("\n") + "\n", "utf-8");
};
