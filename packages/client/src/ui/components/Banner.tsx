import React from "react";
import { Box, Text } from "ink";
import {
  BANNER_BORDER_HEX,
  BANNER_INNER,
  LOGO_GRID,
  LOGO_ROW_WIDTH,
  bannerCenterPad,
  type LogoColor,
} from "../banner/logoArt.js";
import type { BannerProps } from "./types.js";

export type { BannerProps } from "./types.js";

/** Welcome greeting string injected horizontally into the middle of the logo frame. */
const WELCOME_TEXT = "Welcome back";

/**
 * Renders a row of grid-colored squares that comprise the colored startup logo.
 *
 * @remarks
 * Outputs inline blocks mapped to colors in the `LogoColor` theme schema.
 *
 * @param props - Component parameters.
 * @param props.row - The raw color grid columns representing one line of the logo.
 */
const LogoRow: React.FC<{ row: LogoColor[] }> = ({ row }) => (
  <Box>
    {row.map((color, colorIndex) => (
      <Text key={colorIndex} backgroundColor={color ?? undefined}>
        {"  "}
      </Text>
    ))}
  </Box>
);

/**
 * Renders an empty box spacer matching the horizontal grid margins.
 *
 * @remarks
 * Used to insert clean vertical space inside the borders of the banner without breaking the frame.
 *
 * @param props - Component parameters.
 * @param props.border - Closure executing string wraps inside colors.
 */
const BorderedBlank: React.FC<{ border: (s: string) => React.ReactNode }> = ({
  border,
}) => (
  <Text>
    {border("│")}
    {" ".repeat(BANNER_INNER)}
    {border("│")}
  </Text>
);

/**
 * Renders the terminal welcome banner displayed on startup.
 *
 * @remarks
 * Formats a premium visual display container that draws the AtlasAgents logo, version,
 * and currently active models in the terminal.
 *
 * @example
 * ```tsx
 * import React from "react";
 * import { render } from "ink";
 * import { Banner } from "./Banner.js";
 *
 * render(<Banner version="1.0.0" agentModel="gpt-4o" subagentModel="gpt-4o-mini" />);
 * ```
 */
export const Banner: React.FC<BannerProps> = ({
  agentModel,
  subagentModel,
  version,
}) => {
  // Clean up agent model name, falling back to a "not set" placeholder if empty.
  const agent = agentModel.trim() || "not set";

  // Clean up subagent model name, falling back to a "not set" placeholder if empty.
  const subagent = (subagentModel ?? "").trim() || "not set";

  // Compute borders based on the static banner inner width configuration.
  const title = ` AtlasAgents CLI v${version} `;
  const titleDashes = "─".repeat(Math.max(0, BANNER_INNER - 6 - title.length));

  // Decorates frame components with the defined border color schema.
  const border = (borderChar: string) => (
    <Text color={BANNER_BORDER_HEX}>{borderChar}</Text>
  );

  // Center alignments are calculated at layout-time based on terminal column offsets.
  const welcomePadding = bannerCenterPad(WELCOME_TEXT.length);
  const logoPadding = bannerCenterPad(LOGO_ROW_WIDTH);

  return (
    <Box flexDirection="column">
      {/* Upper Border: hosts the application name and version details */}
      <Text>
        {border("╭──────")}
        <Text bold>{title}</Text>
        {border(`${titleDashes}╮`)}
      </Text>

      {/* Top spacing divider */}
      <BorderedBlank border={border} />

      {/* Main greeting line centered inside the frame */}
      <Text>
        {border("│")}
        {" ".repeat(welcomePadding.left)}
        <Text bold>{WELCOME_TEXT}</Text>
        {" ".repeat(welcomePadding.right)}
        {border("│")}
      </Text>

      {/* Spacing between greeting and graphical logo */}
      <BorderedBlank border={border} />

      {/* Grid rendering of logo art */}
      {LOGO_GRID.map((row, rowIndex) => (
        <Box key={rowIndex}>
          {border("│")}
          <Text>{" ".repeat(logoPadding.left)}</Text>
          <LogoRow row={row} />
          <Text>{" ".repeat(logoPadding.right)}</Text>
          {border("│")}
        </Box>
      ))}

      {/* Spacer dividing logo and telemetry specs */}
      <BorderedBlank border={border} />

      {/* Active Agent model information row */}
      <Text>
        {border("│")}
        {"  Agent: "}
        <Text color="cyan">{agent}</Text>
        {" ".repeat(Math.max(0, BANNER_INNER - `  Agent: ${agent}`.length))}
        {border("│")}
      </Text>

      {/* Active Subagent model information row */}
      <Text>
        {border("│")}
        {"  Subagent: "}
        <Text color="cyan">{subagent}</Text>
        {" ".repeat(Math.max(0, BANNER_INNER - `  Subagent: ${subagent}`.length))}
        {border("│")}
      </Text>

      {/* Bottom spacing divider */}
      <BorderedBlank border={border} />

      {/* Lower Border: closes the welcome banner box frame */}
      <Text>{border(`╰${"─".repeat(BANNER_INNER)}╯`)}</Text>
    </Box>
  );
};
