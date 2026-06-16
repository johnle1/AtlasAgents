/**
 * Mount the Ink application (bootstrap → main App).
 */

import React from "react";
import { render } from "ink";
import { BootstrapApp, type BootstrapAppProps } from "./BootstrapApp.js";
import { saveHistory } from "./historyPersist.js";

export type RunInkAppOptions = Pick<
  BootstrapAppProps,
  "cliOverrides" | "needsSetup"
>;

export const runInkApp = (options: RunInkAppOptions): void => {
  const { waitUntilExit } = render(
    <BootstrapApp {...options} onSaveHistory={saveHistory} />,
  );
  void waitUntilExit().then(() => {
    process.exit(0);
  });
};
