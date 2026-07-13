export type DiffChunk = {
  value: string;
  added?: boolean;
  removed?: boolean;
};

export type DisplayRow = {
  kind: "added" | "removed" | "equal";
  text: string;
  lineNum: number;
};
