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

## Documents And Code

Write one complete prose sentence per source line and separate paragraphs with a blank line.
Keep conditions and exceptions with their actions.
Preserve technical meaning, permissions, code, metadata, exact quotations, and licenses.
Use `.yaml` unless its consumer requires another exact filename.
Keep release tooling in `release/` and tests in `tests/` instead of generic helper directories.
Keep skill-owned executable helpers in `skills/<name>/scripts/` when the workflow needs them.
Use existing Node.js, pnpm, and lint tools before adding packages or custom implementations.

## Verification

Install locked dependencies with `pnpm install --frozen-lockfile`.
Run applicable named checks or `pnpm run check` for mixed changes.
Run both Claude plugin validators after changing packaged content.
Inspect changed human-facing documents for rendered readability and verify their links.
Test runtime mutations against disposable socket fixtures only.
Record exact commands, exit codes, coverage, and limitations.
Reuse passing evidence only while its relevant inputs, configuration, and toolchain remain unchanged.
Label actual checks ACTUAL, unchanged proof REUSED, and unavailable checks NOT RUN with the cause.

## Commits And Pull Requests

Create an issue before a new worktree or implementation branch.
Keep primary checkouts on `main` and perform changes in a separate worktree.
Write a descriptive commit title, a blank line, and a body explaining the reason, changes, verification, and limitations.
Put each complete body sentence on its own line and separate paragraphs with blank lines.
Keep private environment details and external work-item identifiers out of committed content.
Use the [pull request template](.github/pull_request_template.md) for the posted change.
Link the issue and use a closing reference only when the acceptance criteria are satisfied.
Obtain independent review of the complete posted change and resolve acceptance blockers before merge.
Verify the named base branch after merge before retiring task-owned branches and worktrees.
Never force-push or rewrite shared history.
