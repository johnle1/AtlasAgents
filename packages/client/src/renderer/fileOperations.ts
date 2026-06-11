import type { DiffChunk } from "@loopycode/shared";
import { beginBlockOutput } from "../agentStatus.js";
import { renderDiffFromChunks } from "../diff/diffRenderer.js";
import { formatDisplayPath } from "../pathDisplay.js";
import { getTheme } from "../theme/themeManager.js";
import { appendBlock, appendDiff } from "./sink.js";

/**
 * <Summary>
 * What it does:
 *   Defines visual icons used to prefix different file operations in the output.
 *
 * Used by:
 *   - All file operation print functions — use these icons to visually distinguish operation types.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
const OPERATION_ICONS = {
  /** Icon for directory listing operations (expandable tree style) */
  listDir: "▸",
  /** Icon for file read operations (vertical bar like file tree) */
  read: "│",
  /** Icon for file write operations (asterisk for modification) */
  write: "*",
  /** Icon for file creation operations (plus sign for addition) */
  create: "+",
  /** Icon for directory creation operations (plus with slash for directory) */
  createDir: "+/",
  /** Icon for deletion operations (minus sign for removal) */
  delete: "-",
  /** Icon for bash/command operations (dollar sign like shell prompt) */
  bash: "$",
  /** Icon for directory change operations (greater-than sign like navigation) */
  cd: ">",
} as const;

/**
 * <Summary>
 * What it does:
 *   Creates a styled operation line with secondary text color for non-critical operations.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Format the target path for display (shortens workspace paths).
 *   3. Build a styled string with the icon, label, and formatted path in secondary color.
 *   4. Return the complete styled operation line.
 *
 * Parameters:
 *   @param {string} icon — The operation icon to display (e.g., "│", "*", "+").
 *   @param {string} label — The operation label (e.g., "Read", "Write", "Create").
 *   @param {string} target — The target path the operation applies to.
 *
 * Returns:
 *   @returns {string} — The styled operation line with secondary text color.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - formatDisplayPath — formats the target path for display.
 *
 * Dependants:
 *   - printRead — uses this to display read operations.
 *   - printCd — uses this to display directory changes.
 * </Summary>
 */
const operationLineDim = (
  icon: string,
  label: string,
  target: string,
): string => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Build styled operation line =====
  // Step 2a: Format the target path for display (shortens workspace paths to relative)
  // Step 2b: Build the operation line with icon, label, and formatted path
  // Step 2c: Use secondary text color to indicate this is a less critical operation
  // Step 2d: Apply theme reset at the end to prevent color bleeding
  return `${theme.textSecondary}${icon} ${label}(${formatDisplayPath(target)})${theme.reset}`;
};

/**
 * <Summary>
 * What it does:
 *   Creates a styled operation line with bold path text for critical operations.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Format the target path for display (shortens workspace paths).
 *   3. Build a styled string with the icon and label in normal text.
 *   4. Format the path with bold styling for emphasis.
 *   5. Return the complete styled operation line.
 *
 * Parameters:
 *   @param {string} icon — The operation icon to display (e.g., "+", "-", "+/").
 *   @param {string} label — The operation label (e.g., "Create", "Delete", "CreateDir").
 *   @param {string} target — The target path the operation applies to.
 *
 * Returns:
 *   @returns {string} — The styled operation line with bold path text.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - formatDisplayPath — formats the target path for display.
 *
 * Dependants:
 *   - printCreate — uses this to display file creation operations.
 *   - printCreateDir — uses this to display directory creation operations.
 *   - printDelete — uses this to display deletion operations.
 * </Summary>
 */
const operationLineBoldPath = (
  icon: string,
  label: string,
  target: string,
): string => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Build styled operation line =====
  // Step 2a: Build the operation line with icon and label in normal text
  // Step 2b: Format the target path for display (shortens workspace paths)
  // Step 2c: Apply bold styling to the path for emphasis on critical operations
  // Step 2d: Apply theme reset at the end to prevent color bleeding
  return `${icon} ${label}(${theme.textBold}${formatDisplayPath(target)}${theme.reset})`;
};

/**
 * <Summary>
 * What it does:
 *   Displays a directory listing operation with expansion hint.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Format the directory path for display.
 *   3. Build a styled line with the list icon, operation label, and path.
 *   4. Add a hint about using ctrl+o to expand the directory.
 *   5. Append the styled line to the output block.
 *
 * Parameters:
 *   @param {string} path — The directory path being listed.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the directory listing operation.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - formatDisplayPath — formats the path for display.
 *   - appendBlock — displays the styled line to the user.
 *
 * Dependants:
 *   - Directory listing operations — use this to display list operations.
 * </Summary>
 */
export const printListDir = (path: string): void => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Build and display directory listing line =====
  // Step 2a: Format the directory path for display (shortens workspace paths)
  // Step 2b: Build the operation line with list icon, operation label, and formatted path
  // Step 2c: Add a hint about using ctrl+o to expand the directory for navigation
  // Step 2d: Use secondary text color to indicate this is a read-only operation
  // Step 2e: Append the styled line to the output block for display
  appendBlock([
    `${theme.textSecondary}${OPERATION_ICONS.listDir} ListDir(${formatDisplayPath(path)})${theme.reset}          ${theme.textSecondary}(ctrl+o to expand)${theme.reset}`,
  ]);
};

/**
 * <Summary>
 * What it does:
 *   Displays a file read operation with minimal styling.
 *
 * How it does it (step by step):
 *   1. Build a styled operation line using the dim formatting function.
 *   2. Use the read icon and "Read" label with the file path.
 *   3. Append the styled line to the output block.
 *
 * Parameters:
 *   @param {string} path — The file path being read.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the read operation.
 *
 * Dependencies:
 *   - operationLineDim — generates the styled operation line.
 *   - appendBlock — displays the styled line to the user.
 *
 * Dependants:
 *   - File read operations — use this to display read operations.
 * </Summary>
 */
export const printRead = (path: string): void => {
  // ===== STEP 1: Build and display read operation line =====
  // Step 1a: Build the styled operation line using the dim formatting function
  // Step 1b: Use the read icon (│) and "Read" label with the file path
  // Step 1c: Append the styled line to the output block for display
  appendBlock([operationLineDim(OPERATION_ICONS.read, "Read", path)]);
};

/**
 * <Summary>
 * What it does:
 *   Displays a file write operation with a diff of the changes.
 *
 * How it does it (step by step):
 *   1. Begin a block output section for formatted display.
 *   2. Render the diff from the diff chunks with syntax highlighting.
 *   3. Append the diff with the file path as the header.
 *
 * Parameters:
 *   @param {string} path — The file path being written.
 *   @param {DiffChunk[]} chunks — Array of diff chunks representing the changes.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves after displaying the write operation with diff.
 *
 * Dependencies:
 *   - beginBlockOutput — starts a formatted output section.
 *   - renderDiffFromChunks — renders the diff with syntax highlighting.
 *   - formatDisplayPath — formats the path for display.
 *   - appendDiff — displays the diff to the user.
 *
 * Dependants:
 *   - File write operations — use this to display write operations with changes.
 * </Summary>
 */
export const printWrite = async (
  path: string,
  diffChunks: DiffChunk[],
): Promise<void> => {
  // ===== STEP 1: Begin formatted output section =====
  // Step 1a: Start a block output section for proper formatting and spacing
  beginBlockOutput();

  // ===== STEP 2: Render diff from chunks =====
  // Step 2a: Render the diff from the diff chunks with syntax highlighting
  // Step 2b: This process can be async as it may involve syntax highlighting
  const diffBody = await renderDiffFromChunks(path, diffChunks);

  // ===== STEP 3: Display diff with header =====
  // Step 3a: Append the diff with the file path as the operation header
  // Step 3b: Format the path for display (shortens workspace paths)
  appendDiff(`Write ${formatDisplayPath(path)}`, diffBody);
};

/**
 * <Summary>
 * What it does:
 *   Displays a file creation operation with a preview of the content.
 *
 * How it does it (step by step):
 *   1. Begin a block output section for formatted display.
 *   2. Build the operation line with bold path styling.
 *   3. Split the preview content into lines.
 *   4. Indent each non-empty line for visual hierarchy.
 *   5. Add blank lines for spacing around the preview.
 *   6. Append the complete lines to the output block.
 *
 * Parameters:
 *   @param {string} path — The file path being created.
 *   @param {string} preview — The content preview to display.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the create operation with preview.
 *
 * Dependencies:
 *   - beginBlockOutput — starts a formatted output section.
 *   - operationLineBoldPath — generates the styled operation line.
 *   - appendBlock — displays the styled lines to the user.
 *
 * Dependants:
 *   - File creation operations — use this to display file creation operations.
 * </Summary>
 */
export const printCreate = (path: string, preview: string): void => {
  // ===== STEP 1: Begin formatted output section =====
  // Step 1a: Start a block output section for proper formatting and spacing
  beginBlockOutput();

  // ===== STEP 2: Build output lines =====
  // Step 2a: Build the operation line with bold path styling for emphasis
  // Step 2b: Add a blank line after the header for spacing
  // Step 2c: Split the preview content into individual lines
  // Step 2d: Map each line: if non-empty, indent with 4 spaces; if empty, keep as blank
  // Step 2e: Add a trailing blank line for spacing
  const outputLines = [
    operationLineBoldPath(OPERATION_ICONS.create, "Create", path),
    "",
    ...preview
      .split("\n")
      .map((previewLine) =>
        previewLine.length > 0 ? `    ${previewLine}` : "",
      ),
    "",
  ];

  // ===== STEP 3: Display output lines =====
  // Step 3a: Append the complete lines to the output block for display
  appendBlock(outputLines);
};

/**
 * <Summary>
 * What it does:
 *   Displays a directory creation operation.
 *
 * How it does it (step by step):
 *   1. Begin a block output section for formatted display.
 *   2. Build the operation line with bold path styling.
 *   3. Add a blank line for spacing.
 *   4. Append the complete lines to the output block.
 *
 * Parameters:
 *   @param {string} path — The directory path being created.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the directory creation operation.
 *
 * Dependencies:
 *   - beginBlockOutput — starts a formatted output section.
 *   - operationLineBoldPath — generates the styled operation line.
 *   - appendBlock — displays the styled lines to the user.
 *
 * Dependants:
 *   - Directory creation operations — use this to display directory creation operations.
 * </Summary>
 */
export const printCreateDir = (path: string): void => {
  // ===== STEP 1: Begin formatted output section =====
  // Step 1a: Start a block output section for proper formatting and spacing
  beginBlockOutput();

  // ===== STEP 2: Build and display output lines =====
  // Step 2a: Build the operation line with bold path styling for emphasis
  // Step 2b: Add a blank line after the header for spacing
  // Step 2c: Append the complete lines to the output block for display
  appendBlock([
    operationLineBoldPath(OPERATION_ICONS.createDir, "CreateDir", path),
    "",
  ]);
};

/**
 * <Summary>
 * What it does:
 *   Displays a file deletion operation with a warning message.
 *
 * How it does it (step by step):
 *   1. Begin a block output section for formatted display.
 *   2. Get the current theme for warning styling.
 *   3. Build the operation line with bold path styling.
 *   4. Add blank lines for spacing around the warning.
 *   5. Build a warning message with warning color and warning icon.
 *   6. Append the complete lines to the output block.
 *
 * Parameters:
 *   @param {string} path — The file path being deleted.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the deletion operation with warning.
 *
 * Dependencies:
 *   - beginBlockOutput — starts a formatted output section.
 *   - operationLineBoldPath — generates the styled operation line.
 *   - getTheme — provides theme colors for warning styling.
 *   - appendBlock — displays the styled lines to the user.
 *
 * Dependants:
 *   - File deletion operations — use this to display deletion operations with warnings.
 * </Summary>
 */
export const printDelete = (path: string): void => {
  // ===== STEP 1: Begin formatted output section =====
  // Step 1a: Start a block output section for proper formatting and spacing
  beginBlockOutput();

  // ===== STEP 2: Get theme for warning styling =====
  // Step 2a: Get the current theme for warning color and styling
  const theme = getTheme();

  // ===== STEP 3: Build and display output lines =====
  // Step 3a: Build the operation line with bold path styling for emphasis
  // Step 3b: Add blank lines for spacing around the warning message
  // Step 3c: Build a warning message with warning color and warning icon (⚠)
  // Step 3d: The warning message clearly states the operation is permanent
  // Step 3e: Append the complete lines to the output block for display
  appendBlock([
    operationLineBoldPath(OPERATION_ICONS.delete, "Delete", path),
    "",
    `  ${theme.warning}⚠${theme.reset}  This permanently removes the file from disk.`,
    "",
  ]);
};

/**
 * <Summary>
 * What it does:
 *   Displays a directory change operation with minimal styling.
 *
 * How it does it (step by step):
 *   1. Build a styled operation line using the dim formatting function.
 *   2. Use the cd icon and "cd" label with the directory path.
 *   3. Append the styled line to the output block.
 *
 * Parameters:
 *   @param {string} path — The directory path being changed to.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the directory change operation.
 *
 * Dependencies:
 *   - operationLineDim — generates the styled operation line.
 *   - appendBlock — displays the styled line to the user.
 *
 * Dependants:
 *   - Directory change operations — use this to display directory change operations.
 * </Summary>
 */
export const printCd = (path: string): void => {
  // ===== STEP 1: Build and display cd operation line =====
  // Step 1a: Build the styled operation line using the dim formatting function
  // Step 1b: Use the cd icon (>) and "cd" label with the directory path
  // Step 1c: Append the styled line to the output block for display
  appendBlock([operationLineDim(OPERATION_ICONS.cd, "cd", path)]);
};

/**
 * <Summary>
 * What it does:
 *   Defines the shape of a directory entry for display purposes.
 *
 * Used by:
 *   - printListDirEntries — uses this type for directory entry parameters.
 *
 * Produced by:
 *   - Directory listing functions — create objects of this shape for display.
 * </Summary>
 */
export type DirEntry = {
  /** The name of the directory entry (file or directory name). */
  name: string;

  /**
   * Indicates whether this entry is a directory.
   * true = directory, false = file.
   */
  isDirectory: boolean;

  /**
   * Optional flag indicating the entry cannot be read.
   * When true, displays an error icon instead of the normal icon.
   */
  noRead?: boolean;
};

/**
 * <Summary>
 * What it does:
 *   Displays a list of directory entries with appropriate icons and indentation.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Calculate the indentation padding based on the indent level.
 *   3. Map each directory entry to a styled display line.
 *   4. Determine the appropriate icon based on entry type and read status.
 *   5. Add expand hint for directories with ctrl+o shortcut.
 *   6. Apply indentation to each line for visual hierarchy.
 *   7. Append all styled lines to the output block.
 *
 * Parameters:
 *   @param {DirEntry[]} entries — Array of directory entries to display.
 *   @param {number} indent — The indentation level (number of spaces to indent).
 *
 * Returns:
 *   @returns {void} — Returns after displaying the directory entries.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - OPERATION_ICONS — provides icons for different entry types.
 *
 * Dependants:
 *   - Directory expansion operations — use this to display expanded directory contents.
 * </Summary>
 */
export const printListDirEntries = (
  entries: DirEntry[],
  indent: number,
): void => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Calculate indentation padding =====
  // Step 2a: Calculate the padding string based on the indent level
  // Step 2b: Each indent level adds two spaces of indentation
  const indentationPadding = " ".repeat(indent);

  // ===== STEP 3: Build styled entry lines =====
  // Step 3a: Map each directory entry to a styled display line
  const entryLines = entries.map((directoryEntry) => {
    // ===== STEP 3a-1: Determine entry icon =====
    // Step 3a-1a: If the entry cannot be read, show error icon (!)
    // Step 3a-1b: If it's a directory, show list icon (▸)
    // Step 3a-1c: If it's a file, show read icon (│)
    const entryIcon = directoryEntry.noRead
      ? `${theme.error}!${theme.reset}`
      : directoryEntry.isDirectory
        ? OPERATION_ICONS.listDir
        : OPERATION_ICONS.read;

    // ===== STEP 3a-2: Determine expand hint =====
    // Step 3a-2a: If the entry is a directory, add expand hint with ctrl+o shortcut
    // Step 3a-2b: If it's a file, no hint is needed (no expansion)
    const expandHint = directoryEntry.isDirectory
      ? `  ${theme.textSecondary}(ctrl+o to expand)${theme.reset}`
      : "";

    // ===== STEP 3a-3: Build complete entry line =====
    // Step 3a-3a: Apply indentation padding for visual hierarchy
    // Step 3a-3b: Add icon, entry name, and expand hint (if applicable)
    return `${indentationPadding}  ${entryIcon} ${directoryEntry.name}${expandHint}`;
  });

  // ===== STEP 4: Display entry lines =====
  // Step 4a: Append all styled entry lines to the output block for display
  appendBlock(entryLines);
};
