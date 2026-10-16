# Codex App-Server Repository Instructions

These instructions govern contributors and are not injected into consumer sessions.
Keep the plugin scoped to guarded MCP access and read-only status monitoring for the existing Codex app-server.
Use [README.md](README.md) for installation and runtime contracts.
Use [CONTRIBUTING.md](CONTRIBUTING.md) for issues, commits, and pull requests.

## Ownership And Layout

Keep runtime entry points at repository root and supporting runtime modules in `lib/`.
Keep native monitor registration in `monitors/`, release gates in `release/`, and disposable fixtures in `tests/`.
Keep lint rules in `rules/` and GitHub automation in `.github/`.
Keep consumer workflows in `skills/` and declare that directory in both host manifests.
Put skill-owned executable helpers in the owning skill's `scripts/` directory when helpers are needed.
Do not introduce generic top-level `scripts/`, `tools/`, or `bin/` directories.
Update consumers and remove superseded paths together.
Add abstractions only for a requirement or another real caller.

## Development

Use the Node.js engine range and pnpm version declared in `package.json`.
Run `pnpm install` after dependency changes and keep the lockfile consistent.
Keep runtime dependencies npm-compatible because installed plugins use local `npm exec` packaging.
Store shared development dependency versions in `pnpm-workspace.yaml` and reference its catalogs.
Use caret `^x.y.z` ranges in pnpm catalogs and never pin versions with a commit hash.
Keep runtime dependency versions in `package.json` so packaging needs no workspace configuration.
Prefer maintained LTS dependency lines and use stable releases when no LTS line exists.
Resolve packaged resources from the executing module rather than the caller's working directory.
Use Ultracite as the only caller of Oxlint and Oxfmt.
Use named regex capture groups and access full matches or subgroups by name.
Use named regex backreferences and replacement references instead of positional references.
Prefer an existing parser or literal operation when it expresses the requirement more clearly.
Inline single-use variables and logic when lint, evaluation order, side effects, and cleanup semantics remain unchanged.
Do not create hypothetical production helpers, expose internals, or add test seams for test convenience.
Test references do not establish production reuse.
Keep `.markdownlint-cli2.jsonc` set to `gitignore: true` and compact table-column style.
Sort configuration object keys and preserve array order and values.
Keep explicit Markdownlint ignores empty unless a concrete file cannot be covered by `.gitignore`.
Declare Husky as a catalog-backed development dependency, set `prepare` to `husky`, and keep real hooks under `.husky/`.
Have the hooks invoke the package's pre-commit and pre-push scripts.
Do not disable rules, add suppressions, or weaken configuration to make checks pass.
Use multiline JSDoc for exported declarations and public class members.
Keep function bodies free of explanatory inline comments and blank lines.
Prefer immutable bindings and preserve exception timing, async ordering, and cleanup semantics.
Prefer condition inversion over mid-function exits when behavior stays intact, subject to lint and formatter output.
Use `.yaml` unless the consuming platform requires another filename.

## Documentation

Write repository guidance and agent-to-agent communication in concise English.
Write complete prose sentences, one sentence per source line, and separate paragraphs with blank lines.
Do not join sentences with semicolons or use em dashes.
Preserve code, metadata, licenses, exact quotations, and required table syntax.
Keep conditions and exceptions beside their governed action.
Use ASCII diagrams and verify local Markdown links.
Use official vendor documentation for technical claims and identify repository preferences as local rules.
Record redistributed or adapted material in `THIRD_PARTY_NOTICES.md`.

## Validation

Run `pnpm run check` for mixed changes and repository-wide validation.
Use named `check:*` commands for bounded changes whose unaffected proof remains valid.
Run `claude plugin validate .` and `claude plugin validate .claude-plugin/plugin.json` after packaged-content changes.
Keep live-daemon mutations out of tests and use the existing disposable Unix-socket fixtures.
Check process, transport, listener, timer, queue, and temporary-directory cleanup on changed lifecycle boundaries.
Make startup, shutdown, cancellation, and retry operations idempotent after partial setup, so repeated cleanup converges without orphaning owned resources.
Distinguish ACTUAL local checks, REUSED unaffected evidence, and NOT RUN checks with their causes.
Source and fixture checks do not establish live host acceptance.

## Release And Publication

Keep matching `yyyy.mm.dd.seq` versions in both host manifests.
Keep the npm-compatible package version required by the runtime packing tests.
The calendar release version belongs to both host manifests, while the marketplace omits its version.
Follow [the release procedure](README.md#version-updates) and increment the sequence for another same-day release.
Publish authorized changes through ordinary reviewed pull requests from separate worktrees.
Keep primary checkouts on `main` and never force-push or rewrite shared history.
Keep credentials, private environment details, and external work-item identifiers out of commits.
Use repository-relative paths and portable examples.
Inspect the diff and passing evidence before publication and integration.
Preserve unrelated work and report precise acceptance blockers.

## Runtime And Catalog Maintenance

Keep protocol schemas generated from the installed Codex CLI rather than committing a snapshot.
Share concurrent generation and successful schema caches between discovery and native validation.
Validate native ClientRequest parameters before connecting and preserve refusal-first behavior.
Keep all other protocol directions discovery-only.
Refresh tools on discovery when CLI versions or schema hashes change, and notify the host with tools/list_changed.
Keep reviewed curated adapter enums and prefer model/list for generic model discovery.
Expose every ClientRequest as a native-schema tool, retaining refusal-only tools for blocked methods.
Preserve curated adapters and their guards alongside native methods.
Use native host tool search without custom tool caps, paging, or generic dispatch.
Unknown methods must retain mutating annotations until their behavior is reviewed.
Keep active-turn inspection and expected turn IDs in the curated steering tools.
Keep connection-scoped commands and watches attached to their originating sockets.
Return streamed command output and forward filesystem changes through native MCP logging.
Propagate cancellation and retire owned sockets, listeners, and identifiers when operations or MCP transport end.
Propagate watch backpressure to native input and cancel pending stdout drains during transport closure.

Maintain shared method policy in `lib/policy.mjs`.
Refused methods may have discoverable tools, but their callbacks must refuse before validation or connecting.
Keep thread archive, unarchive, and delete on the native CLI.
Server-initiated approvals remain refused by `lib/connection.mjs`.

Extend the existing disposable-socket tests for schema conversion, filtering, fallback, and guarded behavior.
Test issue-form structure and behavior without pinning exact descriptive prose.
Do not test mutations against the live daemon.

Keep active-thread sends on the process-local queue unless supported steering is explicitly selected.
Recheck idle state before queued delivery and preserve native writer refusals without retries.
Keep delivery receipts bounded and close queue connections on cancellation, timeout, or transport closure.
Never interpret refused server requests as completion notifications.

Keep packaged monitors on the native Claude Code Monitor contract.
Use read-only native status notifications and event-driven reads, without resuming watched threads.
Keep transport failures distinct from thread systemError and terminal failed outcomes.
Never interpret refused server requests as status notifications.

Keep the thread-control skill and its conditional monitor setup self-contained in `skills/thread-control/`.
Preserve valid Agent Skills frontmatter and manifest registration.
Wildcard monitor snapshots must follow every loaded-thread page and report distinct turn errors without repeating unchanged states.
Use the packaged native monitor rather than ad-hoc watchers, and keep re-arm and stop rules with the skill.
