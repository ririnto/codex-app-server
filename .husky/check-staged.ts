import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { z } from "zod";

const { stdout } = await execa("git", [
  "diff",
  "--cached",
  "--name-only",
  "--no-renames",
  "-z"
]);
const files = stdout.split("\0").filter((file) => file !== "");
const checks = new Set<string>();
const testFiles = new Set<string>();
let packageHookScriptsOnly = false;
if (files.includes("package.json")) {
  const [{ stdout: baseText }, { stdout: stagedText }] = await Promise.all([
    execa("git", ["show", "HEAD:package.json"]),
    execa("git", ["show", ":package.json"])
  ]);
  const manifestSchema = z.record(z.string(), z.unknown());
  const baseManifest = manifestSchema.parse(JSON.parse(baseText));
  const stagedManifest = manifestSchema.parse(JSON.parse(stagedText));
  const baseScripts = manifestSchema.parse(baseManifest.scripts);
  const stagedScripts = manifestSchema.parse(stagedManifest.scripts);
  const baseComparable = { ...baseManifest, scripts: { ...baseScripts } };
  const stagedComparable = {
    ...stagedManifest,
    scripts: { ...stagedScripts }
  };
  delete baseComparable.scripts["pre-commit"];
  delete baseComparable.scripts["pre-push"];
  delete stagedComparable.scripts["pre-commit"];
  delete stagedComparable.scripts["pre-push"];
  packageHookScriptsOnly =
    JSON.stringify(baseComparable) === JSON.stringify(stagedComparable);
}
let runAll = false;
for (const file of files) {
  if (file.startsWith(".husky/") && /\.(?:[cm]?[jt]sx?)$/u.test(file)) {
    checks.add("check:types");
    checks.add("check:ultracite");
  } else if (/\.(?:[cm]?[jt]sx?)$/u.test(file)) {
    if (file.endsWith(".test.ts")) {
      testFiles.add(file);
    } else {
      checks.add("check:test");
    }
    checks.add("check:types");
    checks.add("check:ultracite");
    if (file === "release/check-issue-forms.ts") {
      checks.add("check:issue-forms");
    }
    if (file === "release/check-plugin-version.ts") {
      checks.add("check:plugin-version");
    }
    if (file === "rules/check-workflow-action-defaults.ts") {
      checks.add("check:workflow-action-defaults");
    }
    if (file === "rules/no-box-drawing.ts") {
      checks.add("check:markdownlint-cli2");
    }
  } else if (file.startsWith(".github/ISSUE_TEMPLATE/")) {
    checks.add("check:issue-forms");
    checks.add("check:test");
    checks.add("check:ultracite");
    if (file.endsWith(".md")) {
      checks.add("check:markdownlint-cli2");
    }
  } else if (
    file.startsWith(".github/workflows/") &&
    /\.(?:yml|yaml)$/u.test(file)
  ) {
    checks.add("check:workflow-action-defaults");
    checks.add("check:ultracite");
  } else if (file === ".claude-plugin/plugin.json") {
    checks.add("check:plugin-version");
    checks.add("check:ultracite");
  } else if (file === "package.json") {
    if (packageHookScriptsOnly) {
      checks.add("check:ultracite");
    } else {
      runAll = true;
    }
  } else if (file.endsWith(".md")) {
    checks.add("check:markdownlint-cli2");
    checks.add("check:ultracite");
    if (file.startsWith("skills/")) {
      checks.add("check:test");
    }
  } else {
    runAll = true;
  }
}
const selectedChecks = [...checks].toSorted();
const selectedTestFiles = checks.has("check:test")
  ? []
  : [...testFiles].toSorted();
if (files.length === 0) {
  console.log("No staged paths; no checks are affected.");
}
if (files.length > 0 && runAll) {
  console.log("Running all checks for unclassified staged paths.");
}
if (files.length > 0 && !runAll) {
  if (selectedChecks.length > 0) {
    console.log(
      `Running checks for staged paths: ${selectedChecks.join(", ")}`
    );
  }
  if (selectedTestFiles.length > 0) {
    console.log(
      `Running tests for staged paths: ${selectedTestFiles.join(", ")}`
    );
  }
}
if (runAll) {
  const result = await execa("pnpm", ["run", "check"], {
    reject: false,
    stdio: "inherit"
  });
  process.exitCode = result.exitCode ?? 1;
} else if (files.length > 0) {
  const commands: [string, ...string[]][] = [];
  if (selectedChecks.length > 0) {
    commands.push([
      "/bin/sh",
      fileURLToPath(
        new URL(
          "../skills/thread-control/scripts/run-installed.sh",
          import.meta.url
        )
      ),
      "--pnpm",
      "run-p",
      ...selectedChecks
    ]);
  }
  if (selectedTestFiles.length > 0) {
    commands.push([process.execPath, "--test", ...selectedTestFiles]);
  }
  const results = await Promise.all(
    commands.map(
      async ([command, ...args]) =>
        await execa(command, args, { reject: false, stdio: "inherit" })
    )
  );
  process.exitCode = results.some(({ exitCode }) => exitCode !== 0) ? 1 : 0;
}
