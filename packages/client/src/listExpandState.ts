/**
 * <Summary>
 * What it represents:
 *   One directory entry that can be expanded, tracking its path and nesting depth.
 *
 * Used by:
 *   - pushListDir() — creates entries and adds to stack.
 *   - peekUnexpanded() — returns unexpanded entries.
 *   - File list rendering — uses indent to determine visual nesting level.
 *
 * Properties explain:
 *   - absolutePath: Full path to the directory (e.g., "/Users/john/project/src").
 *   - indent: How many levels deep this directory is (0 = root, 1 = child, etc).
 * </Summary>
 */
export type ListExpandEntry = {
  absolutePath: string;
  indent: number;
};

// ===== MODULE STATE =====
// Step A: Create stack to track directories in order they were listed
// LIFO structure: most recent directory at top of stack (highest index)
// Example: ["/root", "/root/src", "/root/src/utils"]
const stack: ListExpandEntry[] = [];

// Step B: Create set to track which directories have been expanded
// Fast O(1) lookup to check if a directory is already expanded
// Example: {"/root", "/root/src"}
const expanded = new Set<string>();

/**
 * <Summary>
 * What it does:
 *   Adds a directory to the stack of expandable directories so it can later
 *   be expanded by the user with Ctrl+O.
 *
 * How it does it (step by step):
 *   1. Create a new ListExpandEntry with the provided path and indent level.
 *   2. Add this entry to the end of the stack array (LIFO order).
 *   3. Stack now remembers this directory for potential expansion.
 *
 * Parameters:
 *   @param {string} absolutePath — Full path to the directory (e.g., "/home/user/project").
 *   @param {number} indent — Optional nesting depth (default 0 for root level).
 *
 * Returns:
 *   void — called for side effects only (modifies internal stack).
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - ListRenderer — pushes each listed directory to track for expansion.
 * </Summary>
 */
export const pushListDir = (absolutePath: string, indent = 0): void => {
  // ===== STEP 1: Create Entry =====
  // Step 1a: Build new ListExpandEntry with path and indent
  const entry: ListExpandEntry = { absolutePath, indent };

  // ===== STEP 2: Add to Stack =====
  // Step 2a: Push entry to end of stack array
  // This preserves order: newest directory is at highest index
  stack.push(entry);

  // ===== STEP 3: Complete =====
  // Step 3a: Entry is now available for expansion
  // User can press Ctrl+O to expand the most recent unexpanded directory
};

/**
 * <Summary>
 * What it does:
 *   Marks a directory as expanded so it won't be selected again by Ctrl+O.
 *
 * How it does it (step by step):
 *   1. Add the directory path to the expanded set.
 *   2. Expanded set now remembers this directory is no longer eligible for expansion.
 *   3. Future Ctrl+O commands will skip over expanded directories.
 *
 * Parameters:
 *   @param {string} absolutePath — Full path to the directory to mark as expanded.
 *
 * Returns:
 *   void — called for side effects only (modifies expanded set).
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - KeyboardHandler — marks directory expanded after Ctrl+O activation.
 *   - peekUnexpanded() — checks expanded set to find next unexpanded directory.
 * </Summary>
 */
export const markExpanded = (absolutePath: string): void => {
  // ===== STEP 1: Add to Expanded Set =====
  // Step 1a: Add path to the expanded Set
  // Set automatically handles duplicates (no error if already added)
  expanded.add(absolutePath);

  // ===== STEP 2: Mark as No Longer Expandable =====
  // Step 2a: This directory is now in the expanded set
  // Future calls to peekUnexpanded() will skip it
};

/**
 * <Summary>
 * What it does:
 *   Checks if a directory has already been expanded by the user.
 *
 * How it does it (step by step):
 *   1. Check if the directory path exists in the expanded set.
 *   2. Return true if found, false if not found.
 *
 * Parameters:
 *   @param {string} absolutePath — Full path to the directory to check.
 *
 * Returns:
 *   @returns {boolean} — true if expanded, false if not yet expanded.
 *
 * Performance:
 *   - O(1) lookup using Set (constant time, very fast).
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - peekUnexpanded() — uses this to filter unexpanded directories.
 *   - Other UI logic — may check if a directory is already expanded.
 * </Summary>
 */
export const isExpanded = (absolutePath: string): boolean =>
  // ===== STEP 1: Check Set Membership =====
  // Step 1a: Use Set.has() for O(1) fast lookup
  // Returns true if path is in expanded set, false otherwise
  expanded.has(absolutePath);

/**
 * <Summary>
 * What it does:
 *   Returns the most recent directory from the stack that hasn't been
 *   expanded yet, wrapped in a result object for safe, explicit handling.
 *
 * How it does it (step by step):
 *   1. Start at the end of the stack (most recently added directory).
 *   2. Loop backwards through the stack towards the beginning.
 *   3. For each directory, check if it's in the expanded set.
 *   4. If NOT expanded, return result object with found=true and the entry.
 *   5. If ALL directories are expanded, return result with found=false.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {{ found: boolean; entry?: ListExpandEntry }} — Result object
 *     where found=true means entry contains the unexpanded directory,
 *     and found=false means no more directories to expand (entry omitted).
 *
 * Result Object Behavior:
 *   - { found: true, entry: {...} } — Most recent unexpanded directory found.
 *   - { found: false } — All directories already expanded or stack is empty.
 *   - Caller MUST check .found before accessing .entry (TypeScript enforces this).
 *
 * LIFO Behavior:
 *   - Scans from newest (end) to oldest (start) of stack.
 *   - Returns first unexpanded found (guarantees most recent).
 *   - Example: stack=[A, B, C], expanded={A, B} → { found: true, entry: C }.
 *   - Example: stack=[A, B, C], expanded={A, B, C} → { found: false }.
 *
 * Use Case:
 *   - Called when user presses Ctrl+O to find next directory to expand.
 *   - Caller checks .found property to decide if expansion is possible.
 *   - If found=false, Ctrl+O can show message or do nothing safely.
 *
 * Safety Benefits:
 *   - No forgotten null checks (TypeScript requires checking .found).
 *   - Explicit success/failure semantic (found boolean is clear).
 *   - Optional .entry prevents accidental undefined access.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - KeyboardHandler — calls this to find directory for Ctrl+O.
 *   - FileListManager — may call to check available expandable directories.
 * </Summary>
 */
export const peekUnexpanded = (): {
  found: boolean;
  entry?: ListExpandEntry;
} => {
  // ===== STEP 1: Scan Stack from End to Start =====
  // Step 1a: Loop from highest index down to 0 (newest to oldest)
  // Decrement by 1 each iteration (backwards scan)
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    // ===== STEP 2: Get Entry at Current Position =====
    // Step 2a: Retrieve entry from stack at index i
    const entry = stack[i];

    // Step 2b: Defensive check: skip if entry is undefined (shouldn't happen)
    // (TypeScript might warn, but being explicit is safe)
    if (entry && !expanded.has(entry.absolutePath)) {
      // ===== STEP 3: Found Unexpanded Directory =====
      // Step 3a: This directory is in stack but NOT in expanded set
      // Return result object with found=true and the entry
      // Step 3b: Caller MUST check .found before accessing .entry
      return { found: true, entry };
    }
    // Step 3c: If this entry is expanded or undefined, continue to next iteration
  }

  // ===== STEP 4: No Unexpanded Directories Found =====
  // Step 4a: Loop completed without finding any unexpanded directories
  // All directories in stack are already expanded or stack is empty
  // Return result object with found=false (entry property omitted)
  // This forces caller to check .found before trying to use .entry
  return { found: false };
};

/**
 * <Summary>
 * What it does:
 *   Clears all tracking state (stack and expanded set), resetting the module
 *   for a fresh new list of directories.
 *
 * How it does it (step by step):
 *   1. Empty the stack array by setting length to 0.
 *   2. Clear all entries from the expanded set.
 *   3. State is now ready for a new sequence of directories.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   void — called for side effects only (clears state).
 *
 * Use Case:
 *   - Called when starting a fresh file list (new command, new search results).
 *   - Prevents old directory state from carrying over to new list.
 *   - Ensures Ctrl+O starts fresh with all directories unexpanded.
 *
 * Dependencies:
 *   - None.
 *
 * Dependants:
 *   - ListRenderer — calls before starting to build a new list.
 *   - FileListManager — calls when clearing the UI for fresh results.
 * </Summary>
 */
export const clearExpandState = (): void => {
  // ===== STEP 1: Clear Stack =====
  // Step 1a: Set stack.length to 0 to remove all entries
  // This empties the array while keeping the same reference
  stack.length = 0;

  // ===== STEP 2: Clear Expanded Set =====
  // Step 2b: Call clear() to remove all entries from the set
  // After this, no directories are marked as expanded
  expanded.clear();

  // ===== STEP 3: State Reset Complete =====
  // Step 3a: Module is now in initial empty state
  // Ready for a new list of directories to be pushed
};
