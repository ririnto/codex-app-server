import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { load as yamlParser } from "js-yaml";
import { z } from "zod";

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
