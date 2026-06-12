import { getTheme } from "../theme/themeManager.js";
import { appendBlock, appendText } from "./sink.js";

/**
 * <Summary>
 * What it does:
 *   Tracks the last displayed pull progress percentage to avoid duplicate updates.
 *
 * Used by:
 *   - printProgress — checks per-operation tracker to skip duplicate updates.
 *
 * Produced by:
 *   - printProgress — updates tracker when displaying new progress values.
 *   - resetPullProgress — clears tracker entry for an operation.
 *   - finishPullProgress — clears tracker entry for an operation.
 * </Summary>
 */
let lastPullPercentageByOperation = new Map<string, string>();

const resolveOperationId = (operationId?: string): string =>
  operationId ?? "default";

export const resetPullProgress = (operationId?: string): void => {
  lastPullPercentageByOperation.delete(resolveOperationId(operationId));
};

/**
 * <Summary>
 * What it does:
 *   Completes the pull progress display with a blank line and resets tracking.
 *
 * How it does it (step by step):
 *   1. Append a blank line to the output for spacing.
 *   2. Reset the last pull percentage to an empty string.
 *
 * Returns:
 *   @returns {void} — Returns after finalizing the progress display.
 *
 * Dependencies:
 *   - appendText — displays the blank line for spacing.
 *
 * Dependants:
 *   - Model pull operations — call this when pull operation completes.
 * </Summary>
 */
export const finishPullProgress = (operationId?: string): void => {
  appendText("", "secondary");
  lastPullPercentageByOperation.delete(resolveOperationId(operationId));
};

/**
 * <Summary>
 * What it does:
 *   Displays a list of installed models with their details and metadata.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Initialize the output lines array with a leading blank line.
 *   3. If no models are installed, display a message with pull command hint.
 *   4. If models exist, display the count and iterate through each model.
 *   5. For each model, display the name with a numbered prefix.
 *   6. Display optional details: size, modification date, family, and parameters.
 *   7. Add blank lines for spacing between models.
 *   8. Append the complete lines to the output block.
 *
 * Parameters:
 *   @param {Array<{ name: string; size?: number; modified_at?: string; details?: { family?: string; parameter_size?: string; quantization_level?: string; } }>} models — Array of installed model objects with metadata.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the model list.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - appendBlock — displays the styled lines to the user.
 *
 * Dependants:
 *   - Model listing commands — use this to display installed models.
 * </Summary>
 */
export const printInstalledModels = (
  models: Array<{
    name: string;
    size?: number;
    modified_at?: string;
    details?: {
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
    };
  }>,
): void => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Initialize output lines =====
  // Step 2a: Initialize the output lines array with a leading blank line for spacing
  const outputLines: string[] = [""];

  // ===== STEP 3: Handle empty model list =====
  // Step 3a: Check if there are no models installed
  if (models.length === 0) {
    // Step 3b: Display a message indicating no models with pull command hint
    outputLines.push(
      `${theme.textSecondary}  No models installed. Pull one with: /models pull <name>${theme.reset}`,
      "",
    );
    // Step 3c: Append the lines and return early
    appendBlock(outputLines);
    return;
  }

  // ===== STEP 4: Display model count =====
  // Step 4a: Display the number of models found with bold styling
  outputLines.push(
    `${theme.textBold}  Found ${models.length} model(s):${theme.reset}`,
    "",
  );

  // ===== STEP 5: Iterate through models =====
  // Step 5a: Iterate through each model with index for numbering
  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    // Step 5b: Get the current model from the array
    const model = models[modelIndex]!;

    // ===== STEP 5c: Display model name =====
    // Step 5c-1: Display the model name with a numbered prefix
    // Step 5c-2: Use warning color for the number to make it stand out
    outputLines.push(
      `  ${theme.warning}${modelIndex + 1}.${theme.reset} ${model.name}`,
    );

    // ===== STEP 5d: Display model size =====
    // Step 5d-1: If the model has a size value, display it in GB
    // Step 5d-2: Convert bytes to GB and format to 2 decimal places
    if (typeof model.size === "number" && model.size > 0) {
      outputLines.push(
        `     ${theme.textSecondary}Size:${theme.reset} ${(model.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
      );
    }

    // ===== STEP 5e: Display modification date =====
    // Step 5e-1: If the model has a modification date, display it
    // Step 5e-2: Convert the ISO date string to a localized date string
    if (typeof model.modified_at === "string" && model.modified_at.length > 0) {
      outputLines.push(
        `     ${theme.textSecondary}Modified:${theme.reset} ${new Date(model.modified_at).toLocaleString()}`,
      );
    }

    // ===== STEP 5f: Display model family =====
    // Step 5f-1: If the model has family details, display it
    if (model.details?.family) {
      outputLines.push(
        `     ${theme.textSecondary}Family:${theme.reset} ${model.details.family}`,
      );
    }

    // ===== STEP 5g: Display parameter size =====
    // Step 5g-1: If the model has parameter size details, display it
    if (model.details?.parameter_size) {
      outputLines.push(
        `     ${theme.textSecondary}Parameters:${theme.reset} ${model.details.parameter_size}`,
      );
    }

    // ===== STEP 5h: Add spacing =====
    // Step 5h-1: Add a blank line after each model for visual separation
    outputLines.push("");
  }

  // ===== STEP 6: Display output lines =====
  // Step 6a: Append the complete lines to the output block for display
  appendBlock(outputLines);
};

/**
 * <Summary>
 * What it does:
 *   Displays the result of a model search operation with detailed information.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. Initialize the output lines array with a leading blank line.
 *   3. If the model is found, display detailed information about the model.
 *   4. Display name, size, modification date, family, parameters, and quantization.
 *   5. If the model is not found, display a not found message.
 *   6. If other models are available, list them as alternatives.
 *   7. Provide a pull command hint for the missing model.
 *   8. Append the complete lines to the output block.
 *
 * Parameters:
 *   @param {string} query — The model name that was searched for.
 *   @param {{ name: string; size?: number; modified_at?: string; details?: { family?: string; parameter_size?: string; quantization_level?: string; } } | undefined} found — The found model object or undefined if not found.
 *   @param {Array<{ name: string }>} all — Array of all available model names.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the search results.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - appendBlock — displays the styled lines to the user.
 *
 * Dependants:
 *   - Model search commands — use this to display search results.
 * </Summary>
 */
export const printModelFind = (
  query: string,
  found:
    | {
        name: string;
        size?: number;
        modified_at?: string;
        details?: {
          family?: string;
          parameter_size?: string;
          quantization_level?: string;
        };
      }
    | undefined,
  all: Array<{ name: string }>,
): void => {
  // ===== STEP 1: Get theme for styling =====
  // Step 1a: Get the current theme for text coloring and styling
  const theme = getTheme();

  // ===== STEP 2: Initialize output lines =====
  // Step 2a: Initialize the output lines array with a leading blank line for spacing
  const outputLines: string[] = [""];

  // ===== STEP 3: Handle model found case =====
  // Step 3a: Check if the model was found in the search
  if (found) {
    // ===== STEP 3a-1: Display found message =====
    // Step 3a-1a: Display a success message indicating the model was found
    outputLines.push(
      `${theme.textBold}${theme.success}  Model found:${theme.reset}`,
    );

    // ===== STEP 3a-2: Display model name =====
    // Step 3a-2a: Display the model name with accent color for emphasis
    outputLines.push(
      `    ${theme.textAccent}Name:${theme.reset} ${found.name}`,
    );

    // ===== STEP 3a-3: Display model size =====
    // Step 3a-3a: If the model has a size value, display it in GB
    // Step 3a-3b: Convert bytes to GB and format to 2 decimal places
    if (typeof found.size === "number" && found.size > 0) {
      outputLines.push(
        `    ${theme.textAccent}Size:${theme.reset} ${(found.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
      );
    }

    // ===== STEP 3a-4: Display modification date =====
    // Step 3a-4a: If the model has a modification date, display it
    // Step 3a-4b: Convert the ISO date string to a localized date string
    if (typeof found.modified_at === "string" && found.modified_at.length > 0) {
      outputLines.push(
        `    ${theme.textAccent}Modified:${theme.reset} ${new Date(found.modified_at).toLocaleString()}`,
      );
    }

    // ===== STEP 3a-5: Display model family =====
    // Step 3a-5a: If the model has family details, display it
    if (found.details?.family) {
      outputLines.push(
        `    ${theme.textAccent}Family:${theme.reset} ${found.details.family}`,
      );
    }

    // ===== STEP 3a-6: Display parameter size =====
    // Step 3a-6a: If the model has parameter size details, display it
    if (found.details?.parameter_size) {
      outputLines.push(
        `    ${theme.textAccent}Parameters:${theme.reset} ${found.details.parameter_size}`,
      );
    }

    // ===== STEP 3a-7: Display quantization level =====
    // Step 3a-7a: If the model has quantization level details, display it
    if (found.details?.quantization_level) {
      outputLines.push(
        `    ${theme.textAccent}Quantization:${theme.reset} ${found.details.quantization_level}`,
      );
    }
  } else {
    // ===== STEP 3b: Handle model not found case =====
    // Step 3b-1: Display a warning message that the model was not found locally
    outputLines.push(
      `${theme.warning}  Model "${query}" not found locally.${theme.reset}`,
    );

    // ===== STEP 3b-2: Display available models =====
    // Step 3b-2a: If there are other available models, list them as alternatives
    if (all.length > 0) {
      outputLines.push(
        `  ${theme.textSecondary}Available:${theme.reset} ${all.map((model) => model.name).join(", ")}`,
      );
    }

    // ===== STEP 3b-3: Display pull command hint =====
    // Step 3b-3a: Provide a command hint for pulling the missing model
    outputLines.push(
      `  ${theme.textSecondary}Pull it with:${theme.reset} /models pull ${query}`,
    );
  }

  // ===== STEP 4: Add trailing spacing =====
  // Step 4a: Add a blank line at the end for proper spacing
  outputLines.push("");

  // ===== STEP 5: Display output lines =====
  // Step 5a: Append the complete lines to the output block for display
  appendBlock(outputLines);
};

/**
 * <Summary>
 * What it does:
 *   Displays model pull progress with a visual progress bar and status information.
 *
 * How it does it (step by step):
 *   1. Get the current theme for text styling.
 *   2. If there's an error, display the error message in error color and return.
 *   3. If progress data is available (completed and total), calculate percentage.
 *   4. Skip display if percentage hasn't changed (avoid duplicate updates).
 *   5. Build a visual progress bar with filled and empty segments.
 *   6. Convert completed and total sizes to GB for display.
 *   7. Build the progress output string with bar, percentage, and sizes.
 *   8. Add digest hash if available for verification.
 *   9. Display the progress with secondary text styling.
 *   10. If no numeric progress, display the status message or default "pulling…".
 *
 * Parameters:
 *   @param {{ status?: string; completed?: number; total?: number; error?: string; digest?: string }} progress — Progress information object containing status, completion data, error, and digest.
 *
 * Returns:
 *   @returns {void} — Returns after displaying the progress information.
 *
 * Dependencies:
 *   - getTheme — provides theme colors for text styling.
 *   - appendText — displays the progress to the user.
 *
 * Dependants:
 *   - Model pull operations — use this to display download progress.
 * </Summary>
 */
export const printProgress = (
  progress: {
    status?: string;
    completed?: number;
    total?: number;
    error?: string;
    digest?: string;
  },
  operationId?: string,
): boolean => {
  const trackerKey = resolveOperationId(operationId);
  const theme = getTheme();

  if (typeof progress.error === "string" && progress.error.length > 0) {
    appendText(
      `  ${theme.error}error: ${progress.error}${theme.reset}`,
      "error",
    );
    return true;
  }

  if (
    progress.total !== undefined &&
    progress.completed !== undefined &&
    progress.total > 0
  ) {
    const percentage = ((progress.completed / progress.total) * 100).toFixed(1);
    const lastPullPercentage =
      lastPullPercentageByOperation.get(trackerKey) ?? "";
    if (percentage === lastPullPercentage) return false;

    lastPullPercentageByOperation.set(trackerKey, percentage);

    const progressBarWidth = 30;
    const filledBarWidth = Math.floor(
      (progress.completed / progress.total) * progressBarWidth,
    );
    const progressBar =
      "█".repeat(filledBarWidth) +
      "░".repeat(progressBarWidth - filledBarWidth);
    const totalSizeGB = (progress.total / 1024 / 1024 / 1024).toFixed(2);
    const completedSizeGB = (progress.completed / 1024 / 1024 / 1024).toFixed(
      2,
    );
    let progressOutput = `  [${progressBar}] ${percentage}% | ${completedSizeGB}GB / ${totalSizeGB}GB`;
    if (typeof progress.digest === "string" && progress.digest.length > 0) {
      progressOutput += ` | ${progress.digest.substring(0, 12)}...`;
    }
    appendText(progressOutput, "secondary");
    return false;
  }

  const statusMessage =
    typeof progress.status === "string" && progress.status.length > 0
      ? progress.status
      : "pulling…";
  appendText(
    `  ${theme.textSecondary}${statusMessage}${theme.reset}`,
    "secondary",
  );
  return false;
};
