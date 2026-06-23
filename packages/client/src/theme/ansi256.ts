/**
 * <Summary>
 * What it does:
 *   Converts hexadecimal color codes to terminal escape sequences for foreground and background colors.
 *
 * How it fits in the system:
 *   Provides color conversion utilities that automatically detect terminal capabilities and use
 *   the best available color mode (24-bit truecolor or 256-color fallback). This ensures
 *   themes display correctly across different terminal emulators.
 * </Summary>
 */

/**
 * <Summary>
 * What it does:
 *   Defines the 6-step color quantization values for mapping to the ANSI 256-color cube.
 *
 * Used by:
 *   - nearestStepIndex — uses these steps to find the nearest color index.
 *   - hexToAnsi256 — uses these steps to calculate color cube indices.
 *   - hexToAnsi256Bg — uses these steps to calculate color cube indices.
 *
 * Produced by:
 *   - None (static constant defined at module level).
 * </Summary>
 */
const COLOR_STEPS = [0, 95, 135, 175, 215, 255] as const;

/**
 * <Summary>
 * What it does:
 *   Parses a hexadecimal color string into its RGB component values.
 *
 * How it does it (step by step):
 *   1. Remove the leading "#" character from the hex string if present.
 *   2. Extract the red component from the first two characters.
 *   3. Extract the green component from the next two characters.
 *   4. Extract the blue component from the last two characters.
 *   5. Convert each component from hexadecimal to decimal.
 *   6. Return the RGB values as a tuple.
 *
 * Parameters:
 *   @param hex - The hexadecimal color string (e.g., "#FF5733" or "FF5733").
 *
 * Returns:
 *   @returns Tuple containing red, green, and blue values (0-255).
 * </Summary>
 */
const parseHexRgb = (hex: string): [number, number, number] => {
  // ===== STEP 1: Remove hex prefix =====
  // Step 1a: Remove the leading "#" character if present
  // Step 1b: This allows both "#RRGGBB" and "RRGGBB" formats
  const hexString = hex.replace("#", "");

  // ===== STEP 2: Parse RGB components =====
  // Step 2a: Extract the red component from the first two characters (positions 0-1)
  // Step 2b: Extract the green component from the next two characters (positions 2-3)
  // Step 2c: Extract the blue component from the last two characters (positions 4-5)
  // Step 2d: Convert each component from hexadecimal string to decimal number (base 16)
  return [
    parseInt(hexString.slice(0, 2), 16),
    parseInt(hexString.slice(2, 4), 16),
    parseInt(hexString.slice(4, 6), 16),
  ];
};

/**
 * <Summary>
 * What it does:
 *   Detects whether the current terminal supports 24-bit truecolor.
 *
 * How it does it (step by step):
 *   1. Check the COLORTERM environment variable for truecolor indicators.
 *   2. Check the TERM environment variable for modern terminal indicators.
 *   3. Return true if either environment variable indicates truecolor support.
 *
 * Returns:
 *   @returns True if the terminal supports 24-bit truecolor, false otherwise.
 * </Summary>
 */
export const supportsTrueColor = (): boolean => {
  // ===== STEP 1: Check COLORTERM variable =====
  // Step 1a: Get the COLORTERM environment variable, default to empty string
  // Step 1b: Check if it explicitly indicates truecolor support
  const colorTermVariable = process.env.COLORTERM ?? "";
  if (colorTermVariable === "truecolor" || colorTermVariable === "24bit") {
    return true;
  }

  // ===== STEP 2: Check TERM variable =====
  // Step 2a: Get the TERM environment variable, default to empty string
  // Step 2b: Check if it contains modern terminal indicators
  const termVariable = process.env.TERM ?? "";
  // Step 2c: Return true if the terminal type indicates direct or truecolor support
  return termVariable.includes("direct") || termVariable.includes("truecolor");
};

/**
 * <Summary>
 * What it does:
 *   Converts a hexadecimal color to a 24-bit truecolor foreground escape sequence.
 *
 * How it does it (step by step):
 *   1. Parse the hex color into RGB components.
 *   2. Build the ANSI escape sequence for 24-bit foreground color.
 *   3. Return the escape sequence for terminal display.
 *
 * Parameters:
 *   @param hex - The hexadecimal color string (e.g., "#FF5733").
 *
 * Returns:
 *   @returns ANSI escape sequence for 24-bit foreground color (e.g., "\x1b[38;2;255;87;51m").
 * </Summary>
 */
/** Exact RGB foreground (iTerm, VS Code / Cursor integrated terminal, most modern emulators). */
export const hexToTrueColor = (hex: string): string => {
  // ===== STEP 1: Parse hex to RGB =====
  // Step 1a: Parse the hexadecimal color string into red, green, blue components
  const [red, green, blue] = parseHexRgb(hex);

  // ===== STEP 2: Build truecolor escape sequence =====
  // Step 2a: Build the ANSI escape sequence for 24-bit foreground color
  // Step 2b: The format is: ESC[38;2;R;G;Bm where R,G,B are the color components
  // Step 2c: This format is supported by iTerm, VS Code, Cursor, and most modern terminals
  return `\x1b[38;2;${red};${green};${blue}m`;
};

/**
 * <Summary>
 * What it does:
 *   Converts a hexadecimal color to a 24-bit truecolor background escape sequence.
 *
 * How it does it (step by step):
 *   1. Parse the hex color into RGB components.
 *   2. Build the ANSI escape sequence for 24-bit background color.
 *   3. Return the escape sequence for terminal display.
 *
 * Parameters:
 *   @param hex - The hexadecimal color string (e.g., "#FF5733").
 *
 * Returns:
 *   @returns ANSI escape sequence for 24-bit background color (e.g., "\x1b[48;2;255;87;51m").
 * </Summary>
 */
/** Exact RGB background (iTerm, VS Code / Cursor integrated terminal, most modern emulators). */
export const hexToTrueColorBg = (hex: string): string => {
  // ===== STEP 1: Parse hex to RGB =====
  // Step 1a: Parse the hexadecimal color string into red, green, blue components
  const [red, green, blue] = parseHexRgb(hex);

  // ===== STEP 2: Build truecolor escape sequence =====
  // Step 2a: Build the ANSI escape sequence for 24-bit background color
  // Step 2b: The format is: ESC[48;2;R;G;Bm where R,G,B are the color components
  // Step 2c: This format is supported by iTerm, VS Code, Cursor, and most modern terminals
  return `\x1b[48;2;${red};${green};${blue}m`;
};

/**
 * <Summary>
 * What it does:
 *   Finds the index of the nearest color step for a given color value.
 *
 * How it does it (step by step):
 *   1. Initialize the best index to 0 and best distance to infinity.
 *   2. Iterate through all color steps.
 *   3. Calculate the distance between the value and each step.
 *   4. Update the best index and distance if a closer step is found.
 *   5. Return the index of the nearest step.
 *
 * Parameters:
 *   @param value - The color component value (0-255) to find the nearest step for.
 *
 * Returns:
 *   @returns The index (0-5) of the nearest color step in COLOR_STEPS.
 * </Summary>
 */
const nearestStepIndex = (value: number): number => {
  // ===== STEP 1: Initialize tracking variables =====
  // Step 1a: Initialize the best index to 0 (first step)
  let bestIndex = 0;
  // Step 1b: Initialize the best distance to infinity (ensures first comparison succeeds)
  let bestDistance = Infinity;

  // ===== STEP 2: Find nearest step =====
  // Step 2a: Iterate through all color steps in the COLOR_STEPS array
  for (let stepIndex = 0; stepIndex < COLOR_STEPS.length; stepIndex++) {
    // Step 2b: Calculate the absolute distance between the value and the current step
    const distance = Math.abs(COLOR_STEPS[stepIndex]! - value);

    // Step 2c: If this distance is better than the best found so far, update tracking
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = stepIndex;
    }
  }

  // ===== STEP 3: Return nearest step index =====
  // Step 3a: Return the index of the color step closest to the input value
  return bestIndex;
};

/**
 * <Summary>
 * What it does:
 *   Converts a hexadecimal color to the nearest ANSI 256-color foreground escape sequence.
 *
 * How it does it (step by step):
 *   1. Parse the hex color into RGB components.
 *   2. Calculate the chroma (color saturation) to determine if color is near-neutral.
 *   3. Find the nearest color cube indices for each RGB component.
 *   4. Calculate the color cube index using the ANSI 256-color cube formula.
 *   5. Calculate the distance between original color and cube color.
 *   6. For near-neutral colors (low chroma), also calculate the nearest gray ramp index.
 *   7. Choose between gray ramp and color cube based on which is closer.
 *   8. Return the ANSI escape sequence with the chosen color index.
 *
 * Parameters:
 *   @param hex - The hexadecimal color string (e.g., "#FF5733").
 *
 * Returns:
 *   @returns ANSI escape sequence for the nearest 256-color foreground (e.g., "\x1b[38;5;208m").
 * </Summary>
 */
/** Nearest 256-color cube / gray index. */
export const hexToAnsi256 = (hex: string): string => {
  // ===== STEP 1: Parse hex to RGB =====
  // Step 1a: Parse the hexadecimal color string into red, green, blue components
  const [red, green, blue] = parseHexRgb(hex);

  // ===== STEP 2: Calculate color properties =====
  // Step 2a: Find the maximum RGB component (brightness)
  const maxComponent = Math.max(red, green, blue);
  // Step 2b: Find the minimum RGB component (darkest)
  const minComponent = Math.min(red, green, blue);
  // Step 2c: Calculate chroma (color saturation) as the difference between max and min
  const chroma = maxComponent - minComponent;

  // ===== STEP 3: Calculate color cube indices =====
  // Step 3a: Find the nearest step index for each RGB component
  const redIndex = nearestStepIndex(red);
  const greenIndex = nearestStepIndex(green);
  const blueIndex = nearestStepIndex(blue);

  // ===== STEP 4: Calculate color cube index =====
  // Step 4a: Calculate the color cube index using the ANSI 256-color cube formula
  // Step 4b: The formula is: 16 + 36*r + 6*g + b (where r,g,b are step indices 0-5)
  const cubeIndex = 16 + 36 * redIndex + 6 * greenIndex + blueIndex;

  // ===== STEP 5: Calculate cube color distance =====
  // Step 5a: Get the actual RGB values from the color steps
  const cubeRed = COLOR_STEPS[redIndex]!;
  const cubeGreen = COLOR_STEPS[greenIndex]!;
  const cubeBlue = COLOR_STEPS[blueIndex]!;

  // Step 5b: Calculate the Euclidean distance between original color and cube color
  const cubeDistance = Math.sqrt(
    (red - cubeRed) ** 2 + (green - cubeGreen) ** 2 + (blue - cubeBlue) ** 2,
  );

  // ===== STEP 6: Handle near-neutral colors with gray ramp =====
  // Step 6a: For near-neutral colors (low chroma), the gray ramp may be a better match
  // Step 6b: This prevents the color cube from stealing hue from blues/greens/reds
  if (chroma < 24) {
    // ===== STEP 6a-1: Calculate luminance =====
    // Step 6a-1a: Calculate the luminance using standard RGB to grayscale conversion
    // Step 6a-1b: Formula: 0.299*R + 0.587*G + 0.114*B (human eye perception weights)
    const grayValue = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);

    // ===== STEP 6a-2: Find nearest gray ramp index =====
    // Step 6a-2a: Initialize gray index and distance tracking
    let grayRampIndex = 232;
    let grayRampDistance = Infinity;

    // Step 6a-2b: Iterate through the 24 gray ramp steps (indices 232-255)
    for (let stepIndex = 0; stepIndex < 24; stepIndex++) {
      // Step 6a-2c: Calculate the gray value for this step (starts at 8, increments by 10)
      const grayValueAtStep = 8 + stepIndex * 10;

      // Step 6a-2d: Calculate distance between luminance and this gray step
      const distance = Math.abs(grayValue - grayValueAtStep);

      // Step 6a-2e: Update if this step is closer than the previous best
      if (distance < grayRampDistance) {
        grayRampDistance = distance;
        grayRampIndex = 232 + stepIndex;
      }
    }

    // ===== STEP 6a-3: Calculate gray color distance =====
    // Step 6a-3a: Calculate the actual RGB value corresponding to the chosen gray index
    const grayRGBValue = 8 + (grayRampIndex - 232) * 10;

    // Step 6a-3b: Calculate the distance in RGB space (multiplied by sqrt(3) for 3 components)
    const grayRGBDistance = Math.sqrt(3 * (grayValue - grayRGBValue) ** 2);

    // ===== STEP 6a-4: Choose between gray and cube =====
    // Step 6a-4a: Choose the gray ramp if it's closer than the color cube
    const finalIndex =
      grayRGBDistance < cubeDistance ? grayRampIndex : cubeIndex;

    // Step 6a-4b: Return the ANSI escape sequence for the chosen color
    return `\x1b[38;5;${finalIndex}m`;
  }

  // ===== STEP 7: Return color cube escape sequence =====
  // Step 7a: For saturated colors, use the color cube index directly
  return `\x1b[38;5;${cubeIndex}m`;
};

/**
 * <Summary>
 * What it does:
 *   Converts a hexadecimal color to the nearest ANSI 256-color background escape sequence.
 *
 * How it does it (step by step):
 *   1. Parse the hex color into RGB components.
 *   2. Calculate the chroma (color saturation) to determine if color is near-neutral.
 *   3. Find the nearest color cube indices for each RGB component.
 *   4. Calculate the color cube index using the ANSI 256-color cube formula.
 *   5. Calculate the distance between original color and cube color.
 *   6. For near-neutral colors (low chroma), also calculate the nearest gray ramp index.
 *   7. Choose between gray ramp and color cube based on which is closer.
 *   8. Return the ANSI escape sequence with the chosen color index (background variant).
 *
 * Parameters:
 *   @param hex - The hexadecimal color string (e.g., "#FF5733").
 *
 * Returns:
 *   @returns ANSI escape sequence for the nearest 256-color background (e.g., "\x1b[48;5;208m").
 * </Summary>
 */
/** Nearest 256-color cube / gray index for background. */
export const hexToAnsi256Bg = (hex: string): string => {
  // ===== STEP 1: Parse hex to RGB =====
  // Step 1a: Parse the hexadecimal color string into red, green, blue components
  const [red, green, blue] = parseHexRgb(hex);

  // ===== STEP 2: Calculate color properties =====
  // Step 2a: Find the maximum RGB component (brightness)
  const maxComponent = Math.max(red, green, blue);
  // Step 2b: Find the minimum RGB component (darkest)
  const minComponent = Math.min(red, green, blue);
  // Step 2c: Calculate chroma (color saturation) as the difference between max and min
  const chroma = maxComponent - minComponent;

  // ===== STEP 3: Calculate color cube indices =====
  // Step 3a: Find the nearest step index for each RGB component
  const redIndex = nearestStepIndex(red);
  const greenIndex = nearestStepIndex(green);
  const blueIndex = nearestStepIndex(blue);

  // ===== STEP 4: Calculate color cube index =====
  // Step 4a: Calculate the color cube index using the ANSI 256-color cube formula
  // Step 4b: The formula is: 16 + 36*r + 6*g + b (where r,g,b are step indices 0-5)
  const cubeIndex = 16 + 36 * redIndex + 6 * greenIndex + blueIndex;

  // ===== STEP 5: Calculate cube color distance =====
  // Step 5a: Get the actual RGB values from the color steps
  const cubeRed = COLOR_STEPS[redIndex]!;
  const cubeGreen = COLOR_STEPS[greenIndex]!;
  const cubeBlue = COLOR_STEPS[blueIndex]!;

  // Step 5b: Calculate the Euclidean distance between original color and cube color
  const cubeDistance = Math.sqrt(
    (red - cubeRed) ** 2 + (green - cubeGreen) ** 2 + (blue - cubeBlue) ** 2,
  );

  // ===== STEP 6: Handle near-neutral colors with gray ramp =====
  // Step 6a: For near-neutral colors (low chroma), the gray ramp may be a better match
  // Step 6b: This prevents the color cube from stealing hue from blues/greens/reds
  if (chroma < 24) {
    // ===== STEP 6a-1: Calculate luminance =====
    // Step 6a-1a: Calculate the luminance using standard RGB to grayscale conversion
    // Step 6a-1b: Formula: 0.299*R + 0.587*G + 0.114*B (human eye perception weights)
    const grayValue = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);

    // ===== STEP 6a-2: Find nearest gray ramp index =====
    // Step 6a-2a: Initialize gray index and distance tracking
    let grayRampIndex = 232;
    let grayRampDistance = Infinity;

    // Step 6a-2b: Iterate through the 24 gray ramp steps (indices 232-255)
    for (let stepIndex = 0; stepIndex < 24; stepIndex++) {
      // Step 6a-2c: Calculate the gray value for this step (starts at 8, increments by 10)
      const grayValueAtStep = 8 + stepIndex * 10;

      // Step 6a-2d: Calculate distance between luminance and this gray step
      const distance = Math.abs(grayValue - grayValueAtStep);

      // Step 6a-2e: Update if this step is closer than the previous best
      if (distance < grayRampDistance) {
        grayRampDistance = distance;
        grayRampIndex = 232 + stepIndex;
      }
    }

    // ===== STEP 6a-3: Calculate gray color distance =====
    // Step 6a-3a: Calculate the actual RGB value corresponding to the chosen gray index
    const grayRGBValue = 8 + (grayRampIndex - 232) * 10;

    // Step 6a-3b: Calculate the distance in RGB space (multiplied by sqrt(3) for 3 components)
    const grayRGBDistance = Math.sqrt(3 * (grayValue - grayRGBValue) ** 2);

    // ===== STEP 6a-4: Choose between gray and cube =====
    // Step 6a-4a: Choose the gray ramp if it's closer than the color cube
    const finalIndex =
      grayRGBDistance < cubeDistance ? grayRampIndex : cubeIndex;

    // Step 6a-4b: Return the ANSI escape sequence for the chosen color (background variant)
    return `\x1b[48;5;${finalIndex}m`;
  }

  // ===== STEP 7: Return color cube escape sequence =====
  // Step 7a: For saturated colors, use the color cube index directly
  return `\x1b[48;5;${cubeIndex}m`;
};

/**
 * <Summary>
 * What it does:
 *   Returns the best available foreground color escape sequence for a hex color.
 *
 * How it does it (step by step):
 *   1. Check if the terminal supports 24-bit truecolor.
 *   2. If truecolor is supported, use the exact RGB truecolor escape sequence.
 *   3. If not supported, use the nearest 256-color fallback escape sequence.
 *
 * Parameters:
 *   @param hex - The hexadecimal color string (e.g., "#FF5733").
 *
 * Returns:
 *   @returns The best available foreground color escape sequence.
 * </Summary>
 */
/** Best available foreground escape for a hex color. */
export const fg = (hex: string): string =>
  supportsTrueColor() ? hexToTrueColor(hex) : hexToAnsi256(hex);

/**
 * <Summary>
 * What it does:
 *   Returns the best available background color escape sequence for a hex color.
 *
 * How it does it (step by step):
 *   1. Check if the terminal supports 24-bit truecolor.
 *   2. If truecolor is supported, use the exact RGB truecolor background escape sequence.
 *   3. If not supported, use the nearest 256-color background fallback escape sequence.
 *
 * Parameters:
 *   @param hex - The hexadecimal color string (e.g., "#FF5733").
 *
 * Returns:
 *   @returns The best available background color escape sequence.
 * </Summary>
 */
/** Best available background escape for a hex color. */
export const bg = (hex: string): string =>
  supportsTrueColor() ? hexToTrueColorBg(hex) : hexToAnsi256Bg(hex);
