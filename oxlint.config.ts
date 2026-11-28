import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

/**
 * Extends the shared ultracite Oxlint core configuration.
 */
export default defineConfig({
  env: core.env,
  extends: [core],
  options: { typeAware: true }
});
