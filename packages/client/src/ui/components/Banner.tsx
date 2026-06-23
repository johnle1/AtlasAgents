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

/**
 * <Summary>
 * What it does:
 *   Defines the props interface for the Banner component.
 *
 * Used by:
 *   - Banner — receives model names and version through these props.
 *
 * Produced by:
 *   - App component — passes model configuration and version info.
 * </Summary>
 */
export type BannerProps = {
  /** Advisor model name shown in the banner footer. */
  advisorModel: string;
  /** Agent model name shown in the banner footer. */
  agentModel?: string;
  /** CLI version string e.g. "0.2.0". */
  version: string;
};

/** Welcome message displayed in the banner center. */
const WELCOME_TEXT = "Welcome back";

/**
 * <Summary>
 * What it does:
 *   Renders a single row of the LoopyCode logo using colored blocks.
 *
 * How it fits in the system:
 *   Helper component used by Banner to display the ASCII art logo.
 *   Each row consists of colored blocks that form the logo image.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Renders a blank line with border characters on both sides.
 *
 * How it fits in the system:
 *   Helper component used by Banner to create spacing between sections.
 *   Maintains consistent border width and alignment.
 * </Summary>
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
 * <Summary>
 * What it does:
 *   Renders the LoopyCode CLI welcome banner with logo, version info,
 *   and model configuration in a bordered box format.
 *
 * How it fits in the system:
 *   Displays on startup to show the CLI version, configured models,
 *   and LoopyCode branding. Provides visual context about the
 *   current environment and configuration.
 * </Summary>
 */
export const Banner: React.FC<BannerProps> = ({
  advisorModel,
  agentModel,
  version,
}) => {
  // ===== MODEL NAME PROCESSING =====
  // Clean up advisor model name, show "not set" if empty
  const advisor = advisorModel.trim() || "not set";

  // Clean up agent model name, show "not set" if empty or undefined
  const agent = (agentModel ?? "").trim() || "not set";

  // ===== TITLE FORMATTING =====
  const title = ` LoopyCode CLI v${version} `;
  const titleDashes = "─".repeat(Math.max(0, BANNER_INNER - 6 - title.length));

  // ===== BORDER HELPER =====
  // Creates colored border text elements
  const border = (borderChar: string) => (
    <Text color={BANNER_BORDER_HEX}>{borderChar}</Text>
  );

  // ===== CENTERING CALCULATIONS =====
  const welcomePadding = bannerCenterPad(WELCOME_TEXT.length);
  const logoPadding = bannerCenterPad(LOGO_ROW_WIDTH);

  return (
    <Box flexDirection="column">
      {/* ===== TOP BORDER WITH TITLE ===== */}
      <Text>
        {border("╭──────")}
        <Text bold>{title}</Text>
        {border(`${titleDashes}╮`)}
      </Text>

      {/* ===== SPACING AFTER TITLE ===== */}
      <BorderedBlank border={border} />

      {/* ===== WELCOME TEXT ===== */}
      <Text>
        {border("│")}
        {" ".repeat(welcomePadding.left)}
        <Text bold>{WELCOME_TEXT}</Text>
        {" ".repeat(welcomePadding.right)}
        {border("│")}
      </Text>

      {/* ===== SPACING BEFORE LOGO ===== */}
      <BorderedBlank border={border} />

      {/* ===== LOGO GRID ===== */}
      {LOGO_GRID.map((row, rowIndex) => (
        <Box key={rowIndex}>
          {border("│")}
          <Text>{" ".repeat(logoPadding.left)}</Text>
          <LogoRow row={row} />
          <Text>{" ".repeat(logoPadding.right)}</Text>
          {border("│")}
        </Box>
      ))}

      {/* ===== SPACING AFTER LOGO ===== */}
      <BorderedBlank border={border} />

      {/* ===== ADVISOR MODEL INFO ===== */}
      <Text>
        {border("│")}
        {"  Advisor: "}
        <Text color="cyan">{advisor}</Text>
        {" ".repeat(Math.max(0, BANNER_INNER - `  Advisor: ${advisor}`.length))}
        {border("│")}
      </Text>

      {/* ===== AGENT MODEL INFO ===== */}
      <Text>
        {border("│")}
        {"  Agent: "}
        <Text color="cyan">{agent}</Text>
        {" ".repeat(Math.max(0, BANNER_INNER - `  Agent: ${agent}`.length))}
        {border("│")}
      </Text>

      {/* ===== SPACING BEFORE BOTTOM BORDER ===== */}
      <BorderedBlank border={border} />

      {/* ===== BOTTOM BORDER ===== */}
      <Text>{border(`╰${"─".repeat(BANNER_INNER)}╯`)}</Text>
    </Box>
  );
};
