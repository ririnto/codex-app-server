---
name: thread-monitor
description: Use when an authorized task explicitly requests automatic Codex thread monitoring and thread selection was configured before launching Claude Code.
compatibility: Requires Claude Code's native plugin Monitor support, Node.js 24.x, npm, and an existing Codex app-server control socket.
---

# Automatic Thread Monitor

Invoke this skill only to arm automatic monitoring for a configured, authorized selection.
Use the qualified `codex-app-server:thread-monitor` name through the slash command or Skill tool.
Claude Code starts the packaged monitor on this skill's first invocation, rather than at session startup.
Ordinary thread inspection and explicit Monitor watches use the separate `thread-control` skill.

Before interpreting events, read [Monitor Setup](../thread-control/references/monitor.md) for event meanings, ownership, and stop rules.
Set `CODEX_APP_SERVER_MONITOR_THREADS` before launching Claude Code, using assigned thread IDs or an explicitly authorized wildcard.
Without selected threads, this invocation reports a configuration failure and does not connect.
Do not broaden selection or change host settings to recover automatically.

Reuse this automatic monitor while it covers the assignment.
Do not start a duplicate explicit watch.
If the configured selection cannot cover the assignment, use the packaged explicit Monitor input from Monitor Setup.
Stop the owned monitor when its assignment or lease ends.
Socket loss ends monitoring and requires inspection before any authorized re-arm.
