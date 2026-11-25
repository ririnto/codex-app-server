import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { load as yamlParser } from "js-yaml";
import { z } from "zod";

import { validateIssueForms } from "../release/check-issue-forms.mjs";
import { validatePluginVersions } from "../release/check-plugin-version.mjs";

const repositoryRoot = new URL("../", import.meta.url);
const workflowCheck = ["--silent", "run", "check:workflow-action-defaults"];

await test("the workflow package check distinguishes literals, anchors, and aliases", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "codex-workflow-defaults-")
  );
  t.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  const workflow = "check.yaml";
  const fixture = path.join(directory, workflow);
  const args = [...workflowCheck, "--workflows", directory, "--json"];
  const options = { cwd: fileURLToPath(repositoryRoot), reject: false };
  const listing = await execa(
    "pnpm",
    [...workflowCheck, "--list-metadata"],
    options
  );
  assert.equal(listing.exitCode, 0, listing.stderr);
  const metadata = z
    .object({
      "actions/setup-node@v7": z.object({
        inputs: z.object({
          "package-manager-cache": z.object({
            contextDependent: z.string().min(1)
          })
        })
      })
    })
    .parse(JSON.parse(listing.stdout));
  const { contextDependent } =
    metadata["actions/setup-node@v7"].inputs["package-manager-cache"];
  assert.ok(contextDependent.includes("devEngines.packageManager"));
  assert.match(contextDependent, /(?<!\.)\bpackageManager\b/u);
  const controls = `on: push
env:
  DEPTH: &env_depth 1
  USES_KEY: &uses_key uses
  WITH_KEY: &with_key with
jobs:
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
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0.9999999999999995
          filter: "null"
      - uses: actions/checkout@v7
        with:
          fetch-depth: "01"
      - uses: ./left-to-review
`;
  await Promise.all([
    writeFile(path.join(directory, "00-empty.yaml"), ""),
    writeFile(path.join(directory, "01-comments.yaml"), "# workflow notes\n"),
    writeFile(path.join(directory, "02-no-jobs.yaml"), "name: Test\n"),
    writeFile(
      path.join(directory, "03-no-steps.yaml"),
      "jobs: {check: {runs-on: ubuntu-latest}}\n"
    ),
    writeFile(fixture, controls)
  ]);
  const valid = await execa("pnpm", args, options);
  assert.equal(valid.exitCode, 0, valid.stderr);
  assert.equal(valid.stderr, "");
  const failures = `${controls}      - uses: actions/setup-node@v7
        with:
          CHECK-LATEST: &unused false
      - uses: actions/checkout@v7
        with:
          fetch-depth: *env_depth
      - &checkout_step
        uses: actions/checkout@v7
        with: &checkout_inputs
          fetch-depth: &depth 1
      - uses: example/unreviewed@v1
        with: *checkout_inputs
      - uses: actions/checkout@v7
        with: *checkout_inputs
      - *checkout_step
      - run: echo depth
        env:
          DEPTH: *depth
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0.9999999999999996
          sparse-checkout: null
          ssh-key: ""
      - uses: actions/checkout@v7
        with:
          filter: ""
      - ? *uses_key
        : actions/checkout@v7
        ? *with_key
        :
          fetch-depth: 0x1
  sequence_source:
    steps: &shared_steps
      - uses: actions/checkout@v7
        with:
          filter:
  sequence_use:
    steps: *shared_steps
`;
  await writeFile(fixture, failures);
  const invalid = await execa("pnpm", args, options);
  assert.equal(invalid.exitCode, 1, invalid.stderr);
  const location = z.looseObject({
    file: z.literal(workflow),
    line: z.number().int().positive()
  });
  const diagnostic = location.extend({
    input: z.string(),
    kind: z.string(),
    ref: z.string()
  });
  const diagnostics = z.array(diagnostic).parse(JSON.parse(invalid.stderr));
  assert.equal(diagnostics.length, 12);
  const lines = failures.split("\n");
  /** @param {string} text - Unique text on a fixture line. */
  const lineOf = (text) => lines.findIndex((line) => line.includes(text)) + 1;
  for (const result of [valid, invalid]) {
    const reviews = z
      .array(
        location.extend({
          kind: z.literal("local-action-review"),
          ref: z.string()
        })
      )
      .parse(JSON.parse(result.stdout));
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].ref, "./left-to-review");
    assert.equal(reviews[0].line, lineOf("./left-to-review"));
  }
  const byLine = new Map(diagnostics.map((entry) => [entry.line, entry]));
  const redundant = byLine.get(lineOf("CHECK-LATEST: &unused"));
  assert.ok(redundant !== undefined);
  assert.equal(redundant.kind, "omit");
  assert.equal(redundant.ref, "actions/setup-node@v7");
  assert.equal(redundant.input, "CHECK-LATEST");
  assert.ok(
    z.array(z.string()).parse(redundant.removedAnchors).includes("unused")
  );
  const alias = byLine.get(lineOf("fetch-depth: *env_depth"));
  assert.ok(alias !== undefined);
  assert.equal(alias.kind, "hand-edit");
  assert.equal(alias.ref, "actions/checkout@v7");
  assert.equal(alias.input, "fetch-depth");
  const anchorLocation = z.looseObject({
    definition: location,
    name: z.string(),
    uses: z.array(location)
  });
  const envDepth = z
    .array(anchorLocation)
    .parse(alias.anchors)
    .find(({ name }) => name === "env_depth");
  assert.ok(envDepth !== undefined);
  assert.equal(envDepth.definition.line, lineOf("DEPTH: &env_depth"));
  assert.deepEqual(
    new Set(envDepth.uses.map(({ line }) => line)),
    new Set([lineOf("fetch-depth: *env_depth")])
  );
  const shared = byLine.get(lineOf("fetch-depth: &depth"));
  assert.ok(shared !== undefined);
  assert.equal(shared.kind, "shared-definition");
  assert.equal(shared.ref, "actions/checkout@v7");
  assert.equal(shared.input, "fetch-depth");
  assert.deepEqual(
    new Set(z.array(z.string()).parse(shared.actions)),
    new Set(["actions/checkout@v7", "example/unreviewed@v1"])
  );
  const sharedAnchors = z.array(anchorLocation).parse(shared.anchors);
  assert.deepEqual(
    new Set(sharedAnchors.map(({ name }) => name)),
    new Set(["checkout_step", "checkout_inputs", "depth"])
  );
  const scalar = sharedAnchors.find(({ name }) => name === "depth");
  assert.ok(scalar !== undefined);
  assert.equal(scalar.definition.line, lineOf("fetch-depth: &depth"));
  assert.deepEqual(
    new Set(scalar.uses.map(({ line }) => line)),
    new Set([lineOf("DEPTH: *depth")])
  );
  const sharedMappingUse =
    lines.findLastIndex((line) => line.includes("with: *checkout_inputs")) + 1;
  for (const line of [sharedMappingUse, lineOf("- *checkout_step")]) {
    const detached = byLine.get(line);
    assert.ok(detached !== undefined);
    assert.equal(detached.kind, "detach");
    assert.equal(detached.ref, "actions/checkout@v7");
    assert.equal(detached.input, "fetch-depth");
  }
  /** @type {[number, string, string][]} */
  const scalarFindings = [
    [lineOf("fetch-depth: 0.9999999999999996"), "fetch-depth", "omit"],
    [lineOf("sparse-checkout: null"), "sparse-checkout", "omit"],
    [lineOf('filter: ""'), "filter", "omit"],
    [lineOf('ssh-key: ""'), "ssh-key", "omit"],
    [lineOf("fetch-depth: 0x1"), "fetch-depth", "hand-edit"],
    [
      lines.findIndex((line) => line.trim() === "filter:") + 1,
      "filter",
      "hand-edit"
    ],
    [lineOf("steps: *shared_steps"), "filter", "detach"]
  ];
  for (const [line, input, kind] of scalarFindings) {
    const finding = byLine.get(line);
    assert.equal(finding?.ref, "actions/checkout@v7");
    assert.equal(finding?.kind, kind);
    assert.equal(finding?.input, input);
  }
  await writeFile(
    fixture,
    "name: workflow-source-sentinel\njobs: *alias-source-sentinel\n"
  );
  const malformed = await execa("pnpm", args, options);
  assert.equal(malformed.exitCode, 1, malformed.stderr);
  const parseErrors = z
    .array(
      location.extend({
        column: z.number().int().positive(),
        kind: z.literal("parse")
      })
    )
    .parse(JSON.parse(malformed.stderr));
  assert.equal(parseErrors.length, 1);
  assert.equal(parseErrors[0].line, 2);
  assert.ok(!malformed.stderr.includes("source-sentinel"));
  assert.ok(!malformed.stderr.includes(directory));
});

await test("the workflow package check leaves unverified local actions to review", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-local-actions-"));
  t.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  const workflow = "local.yaml";
  const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
  const fixture = `on: push
jobs:
  local:
    steps:
      - uses: ${checkout}
        with:
          ref: \${{ github.workflow_sha }}
      - uses: ./unapproved
      - uses: ./after-action
  replaces_workspace:
    steps:
      - uses: ${checkout}
        with:
          REF: main
          repository: other/repo
      - uses: ./after-checkout
        with:
          fetch-depth: 1
  script:
    steps:
      - uses: ${checkout}
        with:
          ref: \${{ github.workflow_sha }}
      - run: echo hello
      - uses: ./after-script
  empty_workspace:
    steps:
      - uses: ./before-checkout
`;
  await writeFile(path.join(directory, workflow), fixture);
  const result = await execa(
    "pnpm",
    [...workflowCheck, "--workflows", directory, "--json"],
    { cwd: fileURLToPath(repositoryRoot), reject: false }
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const reviews = z
    .array(
      z.looseObject({
        file: z.literal(workflow),
        kind: z.literal("local-action-review"),
        line: z.number().int().positive(),
        reason: z.string(),
        ref: z.string()
      })
    )
    .parse(JSON.parse(result.stdout));
  const lines = fixture.split("\n");
  const expected = new Map([
    ["./unapproved", "metadata"],
    ["./after-action", "workspace"],
    ["./after-checkout", "workspace"],
    ["./after-script", "workspace"],
    ["./before-checkout", "workspace"]
  ]);
  assert.equal(reviews.length, expected.size);
  for (const { line, reason, ref } of reviews) {
    assert.equal(reason, expected.get(ref));
    assert.equal(line, lines.findIndex((text) => text.includes(ref)) + 1);
    expected.delete(ref);
  }
});

await test("the workflow package check rounds exact G15 midpoints on both sides", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "codex-workflow-checkout-")
  );
  t.after(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  const workflows = path.join(directory, ".github", "workflows");
  const rules = path.join(directory, "rules");
  const file = "check.yaml";
  const ref = "./fixture-action";
  const checkoutCommit = "3d3c42e5aac5ba805825da76410c181273ba90b1";
  const args = [...workflowCheck, "--workflows", workflows];
  const options = { cwd: fileURLToPath(repositoryRoot), reject: false };
  await Promise.all([mkdir(workflows, { recursive: true }), mkdir(rules)]);
  const workflow = `on: push
jobs:
  check:
    steps:
      - uses: actions/checkout@${checkoutCommit}
        with:
          ref: \${{ github.workflow_sha }}
      - uses: ${ref}
        with:
          workflow-midpoint: 1000000000000005
          metadata-midpoint: "1E+15"
          odd-midpoint: 1000000000000015
          different: "1000000000000005"
      - uses: ${ref}
        with:
          workflow-midpoint: 1000000000000005
`;
  await Promise.all([
    writeFile(
      path.join(rules, "workflow-action-defaults.yaml"),
      `actions/checkout@v7:
  commit: ${checkoutCommit}
  inputs: {}
${ref}:
  commit: null
  inputs:
    workflow-midpoint: { default: "1E+15" }
    metadata-midpoint: { default: 1000000000000005 }
    odd-midpoint: { default: "1.00000000000002E+15" }
    different: { default: 1000000000000005 }
`
    ),
    writeFile(path.join(workflows, file), workflow)
  ]);
  const listing = await execa("pnpm", [...args, "--list-metadata"], options);
  assert.equal(listing.exitCode, 0, listing.stderr);
  const entries = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(listing.stdout));
  assert.ok(Object.hasOwn(entries, ref));
  const result = await execa("pnpm", [...args, "--json"], options);
  assert.equal(result.exitCode, 1, result.stderr);
  const reviews = z
    .array(
      z.object({
        file: z.literal(file),
        kind: z.literal("local-action-review"),
        line: z.number().int().positive(),
        reason: z.literal("workspace"),
        ref: z.literal(ref)
      })
    )
    .parse(JSON.parse(result.stdout));
  assert.equal(reviews.length, 1);
  const lines = workflow.split("\n");
  assert.equal(
    reviews[0].line,
    lines.findLastIndex((line) => line.includes(ref)) + 1
  );
  const findings = z
    .array(
      z.object({
        file: z.literal(file),
        input: z.string(),
        kind: z.literal("omit"),
        line: z.number().int().positive(),
        ref: z.literal(ref)
      })
    )
    .parse(JSON.parse(result.stderr));
  const inputs = ["workflow-midpoint", "metadata-midpoint", "odd-midpoint"];
  assert.equal(findings.length, inputs.length);
  assert.deepEqual(
    new Map(findings.map(({ input, line }) => [input, line])),
    new Map(
      inputs.map((input) => [
        input,
        lines.findIndex((line) => line.trimStart().startsWith(`${input}:`)) + 1
      ])
    )
  );
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
