import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

/**
 * Extends the shared ultracite Oxlint core configuration.
 */
export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns
});
