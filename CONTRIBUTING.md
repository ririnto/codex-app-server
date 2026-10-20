# Contributing

Read [AGENTS.md](AGENTS.md) before changing this repository.
Use [README.md](README.md#development) for setup and validation commands.

## Issues

Describe the problem, evidence, scope, acceptance criteria, owner, and next action before proposing changes.
Use the [bug report form](.github/ISSUE_TEMPLATE/bug_report.yaml) for defects and the [improvement form](.github/ISSUE_TEMPLATE/improvement.yaml) for requirements.
Complete those sections when creating issues through an API or CLI.
Check overlapping work and keep one writer per shared resource.
Keep new requirements in separate linked issues.
Follow [SECURITY.md](SECURITY.md) for suspected vulnerabilities.

## Verification

Apply the check-selection and fixture requirements in [AGENTS.md](AGENTS.md#validation).
Inspect changed human-facing documents for rendered readability and verify their links.
Record exact commands, exit codes, coverage, and limitations.
Reuse passing evidence only while its relevant inputs, configuration, and toolchain remain unchanged.
Label actual checks ACTUAL, unchanged proof REUSED, and unavailable checks NOT RUN with the cause.
Label failed attempts FAILED without replacing them with later passing results.
Source and fixture checks do not establish live host acceptance.

## Commits And Pull Requests

Create an issue before a new worktree or implementation branch.
Keep primary checkouts on `main` and perform changes in a separate worktree.
Use repository-relative paths and portable examples.
Keep credentials, private environment details, and external work-item identifiers out of committed content.
Write a descriptive commit title, a blank line, and a body explaining the reason, changes, verification, and limitations.
Put each complete body sentence on its own line and separate paragraphs with blank lines.
Use the [pull request template](.github/pull_request_template.md) for the posted change.
Link the issue and use a closing reference only when the acceptance criteria are satisfied.
Inspect the diff and passing evidence before publication and integration.
Obtain independent review of the complete posted change and resolve acceptance blockers before merge.
Preserve unrelated work and report precise acceptance blockers.
Verify the named base branch after merge before retiring task-owned branches and worktrees.
Never force-push or rewrite shared history.
