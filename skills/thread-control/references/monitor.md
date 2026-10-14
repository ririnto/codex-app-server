# Monitor Setup

Use the installed plugin executable as the watch command.
In Claude Code, load [the input asset](../assets/monitor.json) and supply it to the native Monitor tool.
In Codex or another host without that tool, run the same executable through the host's managed background-command facility with its 1800-second deadline and retain its owned process handle for cancellation.
Do not assume a host has Claude Code's Monitor API.
Resolve `CLAUDE_PLUGIN_ROOT` to this plugin's installed root if the host does not provide that environment variable.
The plugin root is two directories above this skill directory.
Replace `${CLAUDE_PLUGIN_ROOT}` in the JSON asset with that resolved root before submitting the Monitor input.
An arbitrary skill asset is not automatically expanded by the host.
Do not replace the executable with a custom watcher.

```sh
NODE_USE_SYSTEM_CA=1 npm exec --yes --install-links --package="${CLAUDE_PLUGIN_ROOT}" -- codex-thread-monitor --thread '*' --status idle --status failed --status systemError --timeout-seconds 1800
```

Quote `'*'` so the shell does not expand filenames.
Replace the wildcard with repeatable `--thread AUTHORIZED_THREAD_ID` arguments when only assigned targets should be watched.
The wildcard silently baselines every loaded-thread page, reads each thread without resuming it, and receives later native broadcasts.
Loaded threads do not cover stored threads absent from daemon memory.
Observation of a wildcard thread grants no authority to steer or delete it.

Use repeatable `--status` filters to select relevant events.
The Monitor input selects idle, failed, and systemError events with the executable's built-in previous-state defaults.
Include `failed` and `systemError` when waiting for completion so failures cannot be mistaken for quiet success.
The command uses the same `CODEX_APP_SERVER_SOCKET` or `CODEX_HOME` selection as the MCP server.
It starts no daemon, acquires no writer, and refuses server-initiated requests.
Event intake follows stdout backpressure, while a separate read-only socket handles initial and idle inspections without blocking their responses.
Both sockets close when the watch ends.

## Deadline And Ownership

Set the native Monitor `timeout_ms` to 1800000 and the executable's `--timeout-seconds` to 1800 for a 30-minute watch.
Claude Code defaults explicit watches to five minutes and allows at most 30 minutes.
Single-prompt non-interactive runs allow at most ten minutes, so use the smaller host deadline in that mode.
At a deadline, verify the assignment and lease are still active, then re-arm one owned watch with the same selection.
Do not overlap watches or create an automatic endless restart loop.

The plugin registers no automatic monitors; start each watch explicitly for its authorized selection.
Use `'*'` only when monitoring every loaded thread is explicitly authorized.
Repeatable `--thread` arguments override comma-separated `CODEX_APP_SERVER_MONITOR_THREADS` in the watch command's environment.
Without selected threads, the executable exits successfully without connecting.
The default statuses are `active,idle,failed,systemError`; add `notLoaded` explicitly only when needed.
Idle and active events with a previous `notLoaded` state are excluded by default, including terminal idle events.
Use `--include-previous-not-loaded` to include that activity under the selected status filters.
Loading activity does not establish completion.
Filtered states remain recorded, so a subsequent `active`-to-`idle` completion remains observable.
Fresh failed turns and thread systemError events bypass this previous-notLoaded activity filter because failures can precede observed active states.
Those failures still follow their name, status, and unknown-previous filters.
Unnamed threads are excluded by default, including their failed turns and thread systemError events.
Use `--include-unnamed` to include them under the existing status and previous-state filters.
Names must contain a non-whitespace character.
Unnamed child failures describe excluded threads, so they do not bypass name selection.
Transport, inspection, and capability diagnostics remain visible independently of thread name and status filters.

Stop the owned explicit watch through the host's native task or process cancellation tool when its assignment completes, lease expires, targets are retired, or monitoring is cancelled.
SIGINT, SIGTERM, and the executable deadline also close its socket and exit successfully.
Socket loss ends the monitor with exit code 1 instead of reconnecting.
Inspect the reported transport failure and re-arm only after the authorized connection is available again.

## Read The Events

Each stdout line is one JSON event.
`threadStatus` includes `threadId`, `threadName`, `status`, and `previous`.
Startup statuses and terminal turns establish silent baselines, so existing idle states and historical failures produce no default events.
Events with `previous: null` remain excluded by default, including newly observed wildcard threads.
Use `--include-initial` for unknown-previous events and diagnostic startup status snapshots.
This opt-in never replays historical turn results.
Use `--status notLoaded` independently to select current notLoaded events.
Name selection, both previous-state categories, and current notLoaded selection require independent opt-ins.
Neither previous-state opt-in selects current notLoaded events, and current-status selection does not enable either previous-state category.
The previous-notLoaded opt-in leaves startup baselines silent.
Native metadata reads supply the current thread name, including renames.
Explicitly included unnamed events use null when absent.
Naming a thread later does not replay suppressed statuses or terminal outcomes.
The ready-to-use Monitor input inherits the executable's named-thread default.
Unchanged states remain quiet.
`active` means work is running, `idle` means the thread stopped being active, and `notLoaded` means it left daemon memory.
An idle event alone does not prove successful completion or delivery.
Read the tail and receipts before claiming either.

`turnError` has `status: "failed"`, `threadId`, `turnId`, and the native `error` when available.
Later idle inspections, terminal completion, and non-retrying error notifications can report new failures.
The initial latest-turn read only establishes deduplication state.
Fresh terminal notifications and status-only active-to-idle changes received during initialization remain observable under the configured filters.
An in-flight native status snapshot can establish the preceding state when it differs from the first buffered status.
Native completion timing keeps confirmed pre-launch turns silent during those races and in buffered terminal broadcasts, including turns older than the baseline.
Per-thread ingress observations preserve unaffected baselines and correlate startup events buffered behind backpressure.
Later terminal notifications deduplicate against the silent historical baseline.
Suppressed historical payloads do not replace fresh terminal identities before later idle inspections.
When a thread rejects paginated turn reads as unsupported, the monitor reads that thread's turns through `thread/read` instead and keeps reporting failed turns, while other threads keep the paginated read.
A thread whose rollout file is still empty or whose history is not materialized yet has its inspection deferred to its next status change instead of reporting an error.
At most 128 threads stay deferred; the oldest deferred thread is dropped silently past that cap and its inspection resumes at its next idle transition, and a thread leaving daemon memory is dropped from the deferral immediately.
A thread using the fallback turn read loads its full turn history on each idle transition, so that read's cost grows with the thread's length.
Distinct failed turns each emit an event, including consecutive failures with no native status change.
The same failed turn is not repeated.
New completed or interrupted turns emit `turnCompleted` with status `idle`, native `turnStatus`, and their exact `turnId`.
Terminal events follow name, status, and previous-state filters, including the failure exception for previous notLoaded states.
Each terminal event includes `finalMessage` from the corresponding turn's last agent message marked `final_answer`.
Missing final answers or unknown phases use null, without substituting progress or an earlier turn's answer.
Native item reads follow every page for that turn, with correlated full-history fallback when unsupported.
Messages remain complete, without truncation or retained message caches.
Final-message read failures preserve selected events and native failures, reporting `enrichmentError` and null for unavailable values.
Failed name reads produce an `inspection` diagnostic by default because the name cannot be established.
Its `sourceEvent` identifies the original event, with `turnId` and `nativeError` retained when available.
With `--include-unnamed`, failed name reads preserve the original event with null `threadName` and `enrichmentError`.
Suppressed unnamed terminal events do not fetch final messages.
Transient native errors marked `willRetry` are not terminal failures.
For errors such as `model_not_found`, preserve the native details, inspect the affected thread, and report the failed turn before changing the model or retrying under the current assignment.

A native `threadStatus` with `systemError` describes that thread's state.
An `inspection` event with `systemError` describes a failed read and leaves other selected threads running.
A `capability` event with `systemError` and `threadId: null` appears once per run when a thread supports no turn read, and terminal notifications still report failures.
A `transport` event with `systemError` and `threadId: null` describes the monitor connection and ends the process.
Startup configuration and initialization failures also use `transport` and exit with code 1.
Server-initiated requests cannot become status or completion events.

Monitor deadlines and cancellation behavior follow the [Claude Code Monitor contract](https://code.claude.com/docs/en/tools-reference#monitor-tool).
The packaged workflow, explicit selection, and re-arm ownership rules are local plugin requirements.
