# Native Thread Retirement

Retire only the exact authorized thread after its pending work ends and its owner releases the lease.
Read its latest request and outcome before deciding that it is complete.
Resolve delivery receipts before retiring a thread.
Check descendants, active queue deliveries, native writer ownership, and consumers of associated worktrees.
Preserve the current thread, unfinished work, unique uncommitted content, recovery state, and required transcripts.
Establish the installed command's complete affected set, including any descendants changed by its backend.
Require authority and preservation evidence for every affected identity before archive or delete.
Preserve the thread when descendant coverage, ownership, or native effects remain unknown.

## Archive Before Delete

Inspect the installed `codex archive --help` and `codex delete --help` before choosing native commands.
Use the same daemon and transport that own the inspected thread.
For a custom socket, pass `--remote unix://SOCKET_PATH` using the `CODEX_APP_SERVER_SOCKET` path.
Keep exact private thread IDs and socket paths in transient execution context, not tracked files or reports.
The plugin refuses archive, unarchive, and delete through raw and generated MCP tools.

```sh
codex archive --remote unix:// AUTHORIZED_THREAD_ID
```

Read back exact native metadata and the archived inventory before any deletion.
Verify the archive outcome for every affected descendant rather than treating the parent's receipt as complete proof.
Use `codex_methods` to inspect the current `thread/list` schema, then its discovered native tool to list archived threads.
Preserve an archive refusal and let the owning host release its writer instead of bypassing the lock.
An archive receipt does not prove filesystem removal or release every associated resource.

Only after explicit human authority covers permanent deletion, confirm that the transcript and recovery state are no longer needed.
Deletion authority must cover each affected descendant as well as the selected parent.
Preserve any action-time confirmation required by the installed native command.

```sh
codex delete --remote unix:// AUTHORIZED_THREAD_ID
```

Verify every affected identity's absence in fresh active and archived inventories after deletion.
Distinguish a verified not-found result from a transport, permission, or database error.
Check that protected threads and preserved associations remain accessible.
Report unverified effects instead of claiming successful permanent deletion.

## Other Resource Boundaries

Thread archive and delete do not authorize Project, Session, attachment, or physical worktree deletion.
Apply each resource's native lifecycle contract and ownership checks separately.
For a completed task-owned worktree, prove its required source is reachable from retained Git before physical removal.
Check dirty, untracked, and required ignored files plus active process consumers before retiring it.
Stop only task-owned watchers and descendants, then verify termination and socket closure.
