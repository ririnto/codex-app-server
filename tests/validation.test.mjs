import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import yamlParser from "markdownlint-cli2/parsers/yaml";
import relativeLinksRule, {
  markdownIt
} from "markdownlint-rule-relative-links";
import { lint } from "markdownlint/promise";

import { validateIssueForms } from "../release/check-issue-forms.mjs";
import { validatePluginVersions } from "../release/check-plugin-version.mjs";

const repositoryRoot = new URL("../", import.meta.url);
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

const lintRelativeLinks = async (filename, content) => {
  const result = await lint({
    config: {
      default: false,
      "relative-links": {
        root_path: "."
      }
    },
    customRules: [relativeLinksRule],
    markdownItFactory: () => markdownIt,
    strings: { [filename]: content }
  });
  return result[filename] ?? [];
};

test("issue form validator accepts the supported textarea schema", () => {
  assert.deepEqual(
    validateIssueForms([
      { content: validIssueForm, source: "bug_report.yaml" }
    ]),
    []
  );
});

test("issue form validator rejects malformed YAML", () => {
  const errors = validateIssueForms([
    { content: "name: [\n", source: "bug_report.yaml" }
  ]);
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /bug_report\.yaml:\d+: issue form must contain valid YAML/u
  );
});

test("issue form validator requires long names, top-level strings, and a body", () => {
  const content = "name: bug\ndescription: ''\nbody: []\n";
  const errors = validateIssueForms([{ content, source: "improvement.yaml" }]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /top-level description must be a non-empty string/u);
  assert.match(errors[1], /name must contain more than 3 characters/u);
  assert.match(errors[2], /top-level body must be a non-empty array/u);
});

test("issue form validator enforces the textarea field contract and id syntax", () => {
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

test("issue form validator rejects duplicate field ids and labels", () => {
  const content = validIssueForm
    .replace("id: evidence", "id: problem")
    .replace("label: Evidence", "label: Problem");
  const errors = validateIssueForms([{ content, source: "bug_report.yaml" }]);
  assert.ok(errors.some((error) => error.includes("repeats field id problem")));
  assert.ok(
    errors.some((error) => error.includes("repeats field label Problem"))
  );
});

test("issue form names must be unique across discovered forms", () => {
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

test("issue forms preserve the five original sections and remove Markdown templates", () => {
  const directory = new URL(".github/ISSUE_TEMPLATE/", repositoryRoot);
  const expectedLabels = [
    "Problem",
    "Evidence",
    "Scope",
    "Acceptance",
    "Ownership And Next Action"
  ];
  const expectedMetadata = {
    bug_report: {
      description:
        "Report a reproducible documentation, MCP, or monitor defect.",
      name: "Bug report"
    },
    improvement: {
      description:
        "Propose a bounded improvement with evidence and acceptance criteria.",
      name: "Improvement request"
    }
  };
  const forms = [];
  for (const filename of ["bug_report", "improvement"]) {
    const formPath = new URL(`${filename}.yaml`, directory);
    const source = `${filename}.yaml`;
    const content = readFileSync(formPath, "utf-8");
    const form = yamlParser(content);
    assert.equal(form.name, expectedMetadata[filename].name);
    assert.equal(form.description, expectedMetadata[filename].description);
    assert.ok(!form.description.endsWith("\n"));
    assert.deepEqual(
      form.body.map((field) => field.attributes.label),
      expectedLabels
    );
    assert.ok(
      form.body.every((field) => field.type === "textarea"),
      "each issue form section must use a textarea"
    );
    assert.ok(
      form.body.every((field) => field.validations?.required === true),
      "each issue form section must require a response"
    );
    assert.ok(
      form.body.every(
        (field) =>
          typeof field.attributes?.description === "string" &&
          field.attributes.description.trim() !== ""
      ),
      "each issue form section must have a non-empty description"
    );
    assert.ok(
      form.body.every((field) => !field.attributes.description.endsWith("\n"))
    );
    assert.equal(existsSync(new URL(`${filename}.md`, directory)), false);
    forms.push({ content, source });
  }
  assert.deepEqual(validateIssueForms(forms), []);
});

test("YAML block scalars preserve literal and folded text without trailing line feeds", () => {
  const parsed = yamlParser(
    "literal: |-\n  first line\n  second line\nfolded: >-\n  first line\n  second line\n"
  );
  assert.equal(parsed.literal, "first line\nsecond line");
  assert.equal(parsed.folded, "first line second line");
  assert.ok(!parsed.literal.endsWith("\n"));
  assert.ok(!parsed.folded.endsWith("\n"));
});

test("relative link rule accepts existing files and headings", async (t) => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "codex-app-server-links-")
  );
  t.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));
  const source = path.join(temporaryRoot, "source.md");
  const target = path.join(temporaryRoot, "target.md");
  writeFileSync(target, "# Target heading\n", "utf-8");
  const errors = await lintRelativeLinks(
    source,
    "[Target](./target.md#target-heading)\n[Repository README](/README.md)\n"
  );
  assert.deepEqual(errors, []);
});

test("relative link rule rejects missing files", async (t) => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "codex-app-server-links-")
  );
  t.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));
  const source = path.join(temporaryRoot, "source.md");
  const errors = await lintRelativeLinks(source, "[Missing](./missing.md)\n");
  assert.equal(errors.length, 1);
  assert.match(errors[0].errorDetail, /should exist in the file system/u);
});

test("plugin version validation accepts matching calendar date releases", () => {
  assert.doesNotThrow(() =>
    validatePluginVersions("2026.10.10.07", "2026.10.10.07")
  );
});

test("plugin version validation rejects invalid format, date, sequence, and parity", () => {
  assert.throws(
    () => validatePluginVersions("2026.10.10", "2026.10.10.01"),
    /format/u
  );
  assert.throws(
    () => validatePluginVersions("2026.02.30.01", "2026.02.30.01"),
    /valid date/u
  );
  assert.throws(
    () => validatePluginVersions("2026.10.10.00", "2026.10.10.00"),
    /non-zero/u
  );
  assert.throws(
    () => validatePluginVersions("2026.10.10.01", "2026.10.10.02"),
    /must match/u
  );
});
