/**
 * Persistent footer status bar: cwd · branch · model · approval mode · context %.
 *
 * @remarks
 * Mounted outside the approval/prompt gate in {@link App} so it stays
 * visible during overlays. Context % comes from the server `usage` frame;
 * until one arrives the last segment is `—`. The approval-mode word is
 * colored (and optionally bold) per {@link approvalModeDisplay}; other
 * segments stay dim. Narrow terminals fall back to a single truncated
 * dim line.
 */

import React, { useMemo } from "react";
import { Box, Text } from "ink";

import { loadConfig } from "../../config/index.js";
import { formatDisplayPath } from "../../utils/pathDisplay.js";
import { useAppContext } from "../../state/DataContext.js";
import {
  buildFooterLine,
  buildFooterSegments,
  footerFitsWidth,
  remainingContextPct,
  type FooterSegment,
} from "../footer/buildFooterLine.js";
import { cachedGitBranch } from "../footer/gitBranch.js";

const renderSegment = (segment: FooterSegment, key: string): React.ReactNode => {
  if (segment.kind === "mode" && segment.color) {
    return (
      <Text key={key} color={segment.color} bold={segment.bold === true}>
        {segment.text}
      </Text>
    );
  }
  return (
    <Text key={key} dimColor>
      {segment.text}
    </Text>
  );
};

/**
 * Renders the persistent status footer.
 */
export const FooterBar: React.FC = () => {
  const { fileProxy, contextUsage, approvalMode } = useAppContext();
  const width = process.stdout.columns ?? 80;

  const footerInput = useMemo(() => {
    let cwd = ".";
    try {
      cwd = formatDisplayPath(fileProxy.getCwd());
    } catch {
      cwd = ".";
    }
    const branch = cachedGitBranch(
      (() => {
        try {
          return fileProxy.getCwd();
        } catch {
          return process.cwd();
        }
      })(),
    );
    const model = (loadConfig().agentModel ?? "").trim() || "—";
    const contextPct =
      contextUsage === null
        ? null
        : remainingContextPct(
            contextUsage.usedTokens,
            contextUsage.contextWindow,
          );
    return {
      cwd,
      branch,
      model,
      approvalMode,
      contextPct,
      width,
    };
  }, [fileProxy, contextUsage, approvalMode, width]);

  const fits = footerFitsWidth(footerInput);
  const segments = fits ? buildFooterSegments(footerInput) : null;
  const truncatedLine = fits ? null : buildFooterLine(footerInput);

  return (
    <Box marginTop={0}>
      {truncatedLine !== null ? (
        <Text dimColor>{truncatedLine}</Text>
      ) : (
        segments!.map((segment, index) => (
          <React.Fragment key={`${segment.kind}-${index}`}>
            {index > 0 ? <Text dimColor>{" · "}</Text> : null}
            {renderSegment(segment, `${segment.kind}-text-${index}`)}
          </React.Fragment>
        ))
      )}
    </Box>
  );
};
