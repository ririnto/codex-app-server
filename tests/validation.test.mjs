import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { load as yamlParser } from "js-yaml";
import { z } from "zod";

import { validateIssueForms } from "../release/check-issue-forms.mjs";
import { validatePluginVersions } from "../release/check-plugin-version.mjs";

const repositoryRoot = new URL("../", import.meta.url);

await test("the workflow check reports only equal literals at approved action refs", async (t) => {
  const directory = await mkdtemp(
    fileURLToPath(new URL("node_modules/.workflow-defaults-", repositoryRoot))
  );
  t.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  const workflow = path.join(".github", "workflows", "check.yaml");
  const fixture = path.join(directory, workflow);
  await mkdir(path.dirname(fixture), { recursive: true });
  await copyFile(
    new URL("package.json", repositoryRoot),
    path.join(directory, "package.json")
  );
  await cp(new URL("rules/", repositoryRoot), path.join(directory, "rules"), {
    recursive: true
  });
  const args = ["--silent", "run", "check:workflow-action-defaults"];
  const options = { cwd: directory, reject: false, stripFinalNewline: false };
  const controls = `jobs:
  check:
    steps:
      - uses: actions/setup-node@v7
        with:
          check-latest: true
          PACKAGE-MANAGER-CACHE: true
          node-version-file: package.json
      - uses: actions/setup-node@v7
        with:
          check-latest: \${{ false }}
      - uses: actions/setup-node@v7
        with:
          check-latest: true
          CHECK-LATEST: false
      - uses: actions/setup-node@v6
        with:
          check-latest: false
      - uses: example/unreviewed@v1
        with:
          check-latest: false
      - uses: pnpm/action-setup@v6
        with:
          run_install: null
`;
  await writeFile(fixture, controls);
  const valid = await execa("pnpm", args, options);
  assert.equal(valid.exitCode, 0, valid.stderr);
  assert.equal(valid.stderr, "");
  await writeFile(
    fixture,
    `${controls}      - uses: actions/setup-node@v7
        with:
          CHECK-LATEST: false
      - uses: actions/checkout@v7
        with:
          fetch-depth: &depth 1
      - run: echo depth
        env:
          DEPTH: *depth
`
  );
  const invalid = await execa("pnpm", args, options);
  assert.equal(invalid.exitCode, 1, invalid.stderr);
  const diagnostics = invalid.stderr.trim().split("\n");
  assert.equal(diagnostics.length, 2, invalid.stderr);
  assert.ok(diagnostics.every((diagnostic) => diagnostic.startsWith(workflow)));
  const redundant = diagnostics.find((diagnostic) =>
    diagnostic.includes(" R35: ")
  );
  assert.ok(redundant?.includes("actions/setup-node@v7") === true);
  assert.ok(redundant.includes("CHECK-LATEST"));
  const anchored = diagnostics.find((diagnostic) =>
    diagnostic.includes(" R35-anchor: ")
  );
  assert.ok(anchored?.includes("actions/checkout@v7") === true);
  assert.ok(anchored.includes("fetch-depth"));
  assert.ok(anchored.includes("&depth"));
  await writeFile(
    fixture,
    "name: workflow-source-sentinel\njobs: *alias-source-sentinel\n"
  );
  const malformed = await execa("pnpm", args, options);
  assert.equal(malformed.exitCode, 1, malformed.stderr);
  const diagnostic = malformed.stderr.trim();
  assert.equal(diagnostic.split("\n").length, 1, malformed.stderr);
  assert.ok(diagnostic.startsWith(`${workflow}:2:`));
  assert.match(diagnostic, /:\d+:\d+: YAML-parse: .+/u);
  assert.ok(!diagnostic.includes("source-sentinel"));
  assert.ok(!diagnostic.includes(directory));
});

const validIssueForm = `name: Bug report
description: Report a reproducible defect.
body:
  - type: textarea
    id: problem
    attributes:
      label: Problem
      description: Describe the defect and its effect.
    validations:
      required: true
  - type: textarea
    id: evidence
    attributes:
      label: Evidence
      description: Provide concrete evidence.
    validations:
      required: true
  - type: textarea
    id: scope
    attributes:
      label: Scope
      description: Identify the affected scope.
    validations:
      required: true
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance
      description: State the observable acceptance criteria.
    validations:
      required: true
  - type: textarea
    id: ownership_next_action
    attributes:
      label: Ownership And Next Action
      description: Name the owner and next action.
    validations:
      required: true
`;

await test("issue form validator accepts the supported textarea schema", () => {
  assert.deepEqual(
    validateIssueForms([
      { content: validIssueForm, source: "bug_report.yaml" }
    ]),
    []
  );
});

await test("issue form validator rejects malformed YAML", () => {
  const errors = validateIssueForms([
    { content: "name: [\n", source: "bug_report.yaml" }
  ]);
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /bug_report\.yaml:\d+: issue form must contain valid YAML/u
  );
});

await test("issue form validator requires long names, top-level strings, and a body", () => {
  const content = "name: bug\ndescription: ''\nbody: []\n";
  const errors = validateIssueForms([{ content, source: "improvement.yaml" }]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /top-level description must be a non-empty string/u);
  assert.match(errors[1], /name must contain more than 3 characters/u);
  assert.match(errors[2], /top-level body must be a non-empty array/u);
  const unicodeErrors = validateIssueForms([
    {
      content:
        "name: '\u{1F600}\u{1F600}\u{1F600}'\ndescription: valid\nbody: []\n",
      source: "unicode.yaml"
    }
  ]);
  assert.ok(
    unicodeErrors.some((error) =>
      error.includes("name must contain more than 3 characters")
    )
  );
});

await test("issue form validator enforces the textarea field contract and id syntax", () => {
  const content = validIssueForm
    .replace(
      "  - type: textarea\n    id: problem",
      "  - type: input\n    id: problem!"
    )
    .replace("    id: evidence\n", "")
    .replace("      label: Evidence\n", "      label: ''\n")
    .replace(
      "      description: Provide concrete evidence.\n",
      "      description: ''\n"
    )
    .replace(
      "    validations:\n      required: true\n  - type: textarea\n    id: scope",
      "    validations:\n      required: false\n  - type: textarea\n    id: scope"
    );
  const errors = validateIssueForms([{ content, source: "bug_report.yaml" }]);
  assert.ok(
    errors.some((error) => error.includes("must use the textarea type"))
  );
  assert.ok(
    errors.some((error) => error.includes("id may contain only letters"))
  );
  assert.ok(
    errors.some((error) => error.includes("must have a non-empty string id"))
  );
  assert.ok(
    errors.some((error) => error.includes("must have a non-empty string label"))
  );
  assert.ok(
    errors.some((error) =>
      error.includes("must have a non-empty string description")
    )
  );
  assert.ok(errors.some((error) => error.includes("must require a response")));
});

await test("issue form validator rejects duplicate field ids and labels", () => {
  const content = validIssueForm
    .replace("id: evidence", "id: problem")
    .replace("label: Evidence", "label: Problem");
  const errors = validateIssueForms([{ content, source: "bug_report.yaml" }]);
  assert.ok(errors.some((error) => error.includes("repeats field id problem")));
  assert.ok(
    errors.some((error) => error.includes("repeats field label Problem"))
  );
});

await test("issue form names must be unique across discovered forms", () => {
  const duplicateName = validIssueForm.replace(
    "name: Bug report",
    "name: BUG REPORT"
  );
  const forms = [
    { content: validIssueForm, source: "bug_report.yaml" },
    { content: duplicateName, source: "duplicate.yaml" }
  ];
  const errors = validateIssueForms(forms);
  assert.ok(
    errors.some((error) =>
      error.includes("name must be unique across issue forms")
    )
  );
});

await test("issue forms keep five required textarea sections and validate cleanly", () => {
  const directory = new URL(".github/ISSUE_TEMPLATE/", repositoryRoot);
  const forms = [];
  for (const source of ["bug_report.yaml", "improvement.yaml"]) {
    const content = readFileSync(new URL(source, directory), "utf-8");
    const form = z
      .looseObject({
        body: z.array(
          z.looseObject({
            attributes: z.looseObject({
              description: z.string(),
              label: z.string()
            }),
            type: z.string(),
            validations: z
              .looseObject({ required: z.boolean().optional() })
              .optional()
          })
        ),
        description: z.string(),
        name: z.string()
      })
      .parse(yamlParser(content));
    assert.ok(!form.description.endsWith("\n"));
    assert.equal(form.body.length, 5);
    assert.ok(
      form.body.every((field) => !field.attributes.description.endsWith("\n"))
    );
    forms.push({ content, source });
  }
  assert.deepEqual(validateIssueForms(forms), []);
});

await test("plugin version validation accepts matching calendar date releases", () => {
  assert.doesNotThrow(() => {
    validatePluginVersions("2026.10.10.07", "2026.10.10.07");
  });
});

await test("plugin version validation rejects invalid format, date, sequence, and parity", () => {
  assert.throws(() => {
    validatePluginVersions("2026.10.10", "2026.10.10.01");
  }, /format/u);
  assert.throws(() => {
    validatePluginVersions("2026.02.30.01", "2026.02.30.01");
  }, /valid date/u);
  assert.throws(() => {
    validatePluginVersions("2026.10.10.00", "2026.10.10.00");
  }, /non-zero/u);
  assert.throws(() => {
    validatePluginVersions("2026.10.10.01", "2026.10.10.02");
  }, /must match/u);
});
